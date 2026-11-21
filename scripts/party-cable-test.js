// Проверка варианта «В моём браузере» (app/party-cable.js) по-настоящему, без живого Discord и без кабеля: Electron
// со скрытым окном, поддельный микрофон Chromium («голос»), вместо звука Discord — синтетический тон кусками, как их
// шлёт main.js (ArrayBuffer по 10 мс). Вывод в устройство в проверке не измерить и не нужно (звук пошёл бы в настоящие
// колонки), поэтому граф собирается в MediaStreamDestination и слушается анализатором (FFT), а сама смесь CableMix
// запускается с устройством { type: 'none' } — проверяются запуск, остановка и освобождение микрофона и контекста.
//   node scripts/party-cable-test.js            Electron — из node_modules, или путь в переменной AURA_ELECTRON
// Окно не показывается, профиль — временный, настройки Aura не трогаются.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  let bin = process.env.AURA_ELECTRON || '';
  if (!bin) {
    try { bin = require('electron'); } catch {}
  }
  if (!bin || !fs.existsSync(bin)) {
    console.log('не проверялось: нет Electron — npm install или AURA_ELECTRON=<путь к electron.exe>');
    process.exit(1);
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(bin, [__filename], { stdio: 'inherit', env, timeout: 120000 });
  process.exit(r.status === null ? 1 : r.status);
}

// ───── внутри Electron ─────
const { app, BrowserWindow, session } = require('electron');
const http = require('http');
const repo = path.join(__dirname, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-cable-test-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // как в main.js
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});

const TONE = 2500; // Гц — «звук Discord»
let failed = 0, passed = 0;
const ok = (name, cond, detail) => {
  if (cond) passed++;
  else failed++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};

// Страница: party-cable.js как в окне Aura (обычный <script>), плюс помощники проверки.
const PAGE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
// «Звук Discord»: куски по 480 отсчётов каждые 10 мс, ArrayBuffer — как из main.js
function toneFeed(push, hz) {
  let n = 0;
  const t = setInterval(() => {
    const x = new Float32Array(480);
    for (let i = 0; i < 480; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * hz * (n + i)) / 48000);
    n += 480;
    push(x.buffer);
  }, 10);
  return () => clearInterval(t);
}
// Спектр потока: тон над фоном (дБ), самый громкий пик вне тона, вся мощность
async function listen(stream, hz) {
  const ctx = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  const an = ctx.createAnalyser();
  an.fftSize = 8192;
  an.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(stream).connect(an);
  await sleep(1200);
  const bins = new Float32Array(an.frequencyBinCount), acc = new Float64Array(bins.length);
  for (let k = 0; k < 12; k++) {
    an.getFloatFrequencyData(bins);
    for (let i = 0; i < bins.length; i++) acc[i] += Math.pow(10, bins[i] / 10);
    await sleep(90);
  }
  await ctx.close();
  const step = 48000 / 8192, at = Math.round(hz / step);
  const around = [];
  for (let i = Math.round(1500 / step); i < Math.round(4000 / step); i++) if (Math.abs(i - at) > 6) around.push(acc[i]);
  around.sort((a, b) => a - b);
  const floor = around[around.length >> 1] || 1e-30;
  const db = (x) => Math.max(-999, Math.round(10 * Math.log10((x || 0) / floor)));
  let peak = 5;
  for (let i = 5; i < acc.length; i++) if (Math.abs(i - at) > 6 && acc[i] > acc[peak]) peak = i;
  let power = 0, low = 0;
  for (let i = 1; i < acc.length; i++) power += acc[i];
  for (let i = 1; i < 18; i++) low = Math.max(low, acc[i]); // до 100 Гц: щелчки и провалы буфера дают именно это
  const voiceAt = (f) => db(Math.max(acc[Math.round(f / step) - 1], acc[Math.round(f / step)], acc[Math.round(f / step) + 1]));
  return { toneDb: db(Math.max(acc[at - 1], acc[at], acc[at + 1])), peakHz: Math.round(peak * step), peakDb: db(acc[peak]), lowDb: db(low), power, at: window.voiceHz ? voiceAt(window.voiceHz) : null };
}
window.runAll = async (hz) => {
  const out = {};
  // 0. Голос сам по себе: где его пик
  const m0 = await mic();
  out.alone = await listen(m0, hz);
  window.voiceHz = out.alone.peakHz; // дальше голос ищется на этой частоте
  // 1. Граф: голос + тон → MediaStreamDestination
  const ctx = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  const dest = ctx.createMediaStreamDestination();
  const g = await buildCableGraph(ctx, { voice: m0, out: dest });
  let stopFeed = toneFeed((b) => g.push(b), hz);
  out.mix = await listen(dest.stream, hz);
  // 1b. Куски пришли пачкой (секунда разом): задержка не копится — тон и голос на месте
  const burst = new Float32Array(48000);
  for (let i = 0; i < burst.length; i++) burst[i] = 0.25 * Math.sin((2 * Math.PI * hz * i) / 48000);
  g.push(burst.buffer);
  out.burst = await listen(dest.stream, hz);
  // 2. Остановка графа: в выходе тишина
  stopFeed();
  g.stop();
  g.push(new Float32Array(480).buffer); // после остановки — молча мимо
  out.stopped = await listen(dest.stream, hz);
  await ctx.close();
  m0.getTracks().forEach((t) => t.stop());
  // 3. Без голоса (голос в кабель уже играет движок): только звонок
  const ctx2 = new AudioContext({ sampleRate: 48000, sinkId: { type: 'none' } });
  const dest2 = ctx2.createMediaStreamDestination();
  const g2 = await buildCableGraph(ctx2, { voice: null, out: dest2 });
  stopFeed = toneFeed((b) => g2.push(b), hz);
  out.noVoice = await listen(dest2.stream, hz);
  stopFeed();
  g2.stop();
  await ctx2.close();
  // 4. CableMix целиком, устройство { type: 'none' }: играет, останавливается, освобождает микрофон и контекст
  const m1 = await mic();
  const mix = new CableMix();
  let changes = 0;
  mix.onchange = () => changes++;
  await mix.start({ voice: m1, own: true, sinkId: { type: 'none' } });
  const ctxOf = mix.ctx;
  out.started = { playing: mix.playing, state: ctxOf.state, rate: ctxOf.sampleRate, sink: typeof ctxOf.sinkId === 'object' ? ctxOf.sinkId.type : ctxOf.sinkId, changes };
  stopFeed = toneFeed((b) => mix.push(b), hz);
  await sleep(300);
  stopFeed();
  await mix.stop();
  out.mixStopped = { playing: mix.playing, ctx: mix.ctx, state: ctxOf.state, track: m1.getAudioTracks()[0].readyState };
  mix.push(new Float32Array(480).buffer); // после остановки — без ошибок
  // 5. Устройства нет: start бросает, микрофон и контекст освобождены, звук никуда не пошёл
  const m2 = await mic();
  const bad = new CableMix();
  try {
    await bad.start({ voice: m2, own: true, sinkId: 'no-such-device' });
    out.badSink = { threw: false };
  } catch (e) {
    out.badSink = { threw: true, ctx: bad.ctx, playing: bad.playing, track: m2.getAudioTracks()[0].readyState };
  }
  // 6. Чужой голос (own: false) — смесь его не останавливает
  const m3 = await mic();
  const keep = new CableMix();
  await keep.start({ voice: m3, own: false, sinkId: { type: 'none' } });
  await keep.stop();
  out.notOwn = m3.getAudioTracks()[0].readyState;
  m3.getTracks().forEach((t) => t.stop());
  return out;
};
`;

const server = http.createServer((req, res) => {
  if (req.url === '/party-cable.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(fs.readFileSync(path.join(repo, 'app', 'party-cable.js')));
  }
  if (req.url === '/page.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(PAGE);
  }
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>t</title><script src="/party-cable.js"></script><script src="/page.js"></script>');
  }
  res.writeHead(404);
  res.end();
});

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ses = session.fromPartition('party-cable-test'); // в памяти
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media' || permission === 'speaker-selection'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'speaker-selection');
  const w = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  w.webContents.on('console-message', (e) => { if (e.level === 'error') console.log('  [страница]', e.message); });
  try {
    await w.loadURL(`http://127.0.0.1:${server.address().port}/`);
    const r = await Promise.race([w.webContents.executeJavaScript(`runAll(${TONE})`), new Promise((_, no) => setTimeout(() => no(new Error('страница не ответила')), 60000))]);
    console.log('     поддельный микрофон: пик ' + r.alone.peakHz + ' Гц, ' + r.alone.peakDb + ' дБ над фоном');
    ok('голос сам по себе слышен', r.alone.peakDb >= 10, r.alone);
    ok('смесь: тон (звук Discord) есть', r.mix.toneDb >= 20, r.mix.toneDb);
    // голос ищется на частоте пика поддельного микрофона (у него есть ещё и низкий гул огибающей — на него не смотрим)
    ok('смесь: голос есть', r.mix.at >= 10, r.mix.at);
    ok('пачка кусков: тон и голос на месте', r.burst.toneDb >= 20 && r.burst.at >= 10, [r.burst.toneDb, r.burst.at]);
    ok('граф остановлен: в выходе тишина', r.stopped.power < 1e-12, r.stopped.power);
    ok('без голоса: тон есть', r.noVoice.toneDb >= 20, r.noVoice.toneDb);
    ok('без голоса: голоса нет', r.noVoice.at < 6, r.noVoice.at);
    ok('CableMix: играет, 48 кГц, в заданное устройство', r.started.playing && r.started.state === 'running' && r.started.rate === 48000 && r.started.sink === 'none' && r.started.changes >= 1, r.started);
    ok('CableMix.stop: контекст закрыт, свой микрофон остановлен', !r.mixStopped.playing && r.mixStopped.ctx === null && r.mixStopped.state === 'closed' && r.mixStopped.track === 'ended', r.mixStopped);
    ok('устройства нет: start бросает, всё освобождено', r.badSink.threw && r.badSink.ctx === null && !r.badSink.playing && r.badSink.track === 'ended', r.badSink);
    ok('чужой голос (own: false) не останавливается', r.notOwn === 'live', r.notOwn);
  } catch (e) {
    failed++;
    console.log('FAIL ' + (e && e.stack || e));
  }
  console.log((failed ? 'НЕ ПРОШЛО: ' + failed : 'всё прошло') + ' · проверок: ' + (passed + failed));
  w.destroy();
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
});

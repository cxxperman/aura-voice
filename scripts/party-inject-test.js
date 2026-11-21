// Проверка «Пати через Discord» по-настоящему, без живого Discord: Electron со скрытыми окнами, поддельный микрофон
// Chromium, своя локальная страница. Вместо звука Discord в окно идёт синтетический тон — тем же путём, что в main.js
// (FrameFeed из party-discord.js, канал party:discord-pcm, подписка party:discord-want из party-preload.js). Страница
// сама берёт микрофон через getUserMedia и ищет в нём тон анализатором (FFT).
//   node scripts/party-inject-test.js            Electron — из node_modules, или путь в переменной AURA_ELECTRON
// Случаи: страница; iframe с другого origin (отдельный процесс); страница со строгим CSP (AudioWorklet не грузится —
// запасной путь); deviceId и видео; без режима — getUserMedia родной и тона нет.
// Окна не показываются, профиль — временный, настоящие настройки Aura и окна пати не трогаются.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

if (!process.versions.electron) {
  // ───── запуск из node: найти Electron и запустить этот же файл в нём ─────
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
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http');
const repo = path.join(__dirname, '..');
const { FrameFeed } = require(path.join(repo, 'party-discord.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-inject-test-'));
app.setPath('userData', tmp);
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // как в main.js
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {}); // окна закрываются между случаями — сам Electron при этом не выходит

const TONE = 2500; // Гц — «звук Discord»
let failed = 0, passed = 0;
const ok = (name, cond, detail) => {
  if (cond) passed++;
  else failed++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail) : ''));
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// То, что делает страница сайта: микрофон, анализатор, остановка дорожки.
const PROBE = `
window.probe = async (hz, opts) => {
  const out = { native: String(MediaDevices.prototype.getUserMedia).includes('[native code]') };
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  out.inputs = inputs.length;
  const id = inputs.find((d) => d.deviceId && d.deviceId !== 'default')?.deviceId || '';
  const s = await navigator.mediaDevices.getUserMedia(opts.byId && id ? { audio: { deviceId: { exact: id } }, video: !!opts.video } : { audio: true, video: !!opts.video });
  const t = s.getAudioTracks()[0];
  out.audioTracks = s.getAudioTracks().length;
  out.videoTracks = s.getVideoTracks().length;
  out.label = t.label;
  out.deviceIdAsked = id;
  out.deviceId = t.getSettings().deviceId || '';
  const ctx = new AudioContext({ sampleRate: 48000 });
  const an = ctx.createAnalyser();
  an.fftSize = 8192;
  an.smoothingTimeConstant = 0;
  ctx.createMediaStreamSource(s).connect(an);
  await new Promise((r) => setTimeout(r, 1200));
  const bins = new Float32Array(an.frequencyBinCount), acc = new Float64Array(bins.length);
  for (let k = 0; k < 12; k++) {
    an.getFloatFrequencyData(bins);
    for (let i = 0; i < bins.length; i++) acc[i] += Math.pow(10, bins[i] / 10);
    await new Promise((r) => setTimeout(r, 90));
  }
  const step = 48000 / 8192, at = Math.round(hz / step);
  const tone = Math.max(acc[at - 1], acc[at], acc[at + 1]);
  const around = [];
  for (let i = Math.round(1500 / step); i < Math.round(4000 / step); i++) if (Math.abs(i - at) > 6) around.push(acc[i]);
  around.sort((a, b) => a - b);
  out.toneDb = Math.round(10 * Math.log10(tone / (around[around.length >> 1] || 1e-30)));
  let peak = 0;
  for (let i = 5; i < acc.length; i++) if (Math.abs(i - at) > 6 && acc[i] > acc[peak]) peak = i;
  out.micPeakHz = Math.round(peak * step);
  out.micPeakDb = Math.round(10 * Math.log10(acc[peak] / (around[around.length >> 1] || 1e-30)));
  const stopped = [];
  const stop = MediaStreamTrack.prototype.stop;
  MediaStreamTrack.prototype.stop = function () { stopped.push(this.label); return stop.call(this); };
  s.getTracks().forEach((x) => x.stop());
  MediaStreamTrack.prototype.stop = stop;
  out.stoppedThroughPrototype = stopped; // с подменой — это настоящий микрофон, остановленный вслед за дорожкой сайта
  out.ownStop = Object.prototype.hasOwnProperty.call(t, 'stop');
  out.state = t.readyState;
  ctx.close();
  return out;
};
`;

const server = http.createServer((req, res) => {
  const port = server.address().port;
  const html = (body, headers = {}) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
    res.end(`<!doctype html><meta charset="utf-8"><title>t</title>${body}`);
  };
  if (req.url === '/probe.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    return res.end(PROBE);
  }
  if (req.url === '/top') return html('<script src="/probe.js"></script>');
  if (req.url === '/csp') return html('<script src="/probe.js"></script>', { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'" });
  if (req.url === '/frame-host') return html(`<iframe allow="microphone" src="http://localhost:${port}/top"></iframe>`); // localhost ≠ 127.0.0.1: другой origin
  res.writeHead(404);
  res.end();
});

// Как в main.js: фреймы, попросившие звук, и тон вместо Discord
const feed = new FrameFeed('party:discord-pcm');
let current = null;
ipcMain.on('party:discord-want', (e) => { if (current && e.sender === current.webContents) feed.want(e.senderFrame); });
ipcMain.on('party:discord-unwant', (e) => { if (e.senderFrame) feed.unwant(e.senderFrame); });
let sent = 0;
const t0 = Date.now();
setInterval(() => {
  const due = Math.floor(((Date.now() - t0) / 1000) * 48000);
  while (sent + 480 <= due) {
    const x = new Float32Array(480);
    for (let i = 0; i < 480; i++) x[i] = 0.25 * Math.sin((2 * Math.PI * TONE * (sent + i)) / 48000);
    sent += 480;
    if (feed.size) feed.send(x.buffer);
  }
}, 10);

function makeWin(discord) {
  const ses = session.fromPartition('party-inject-test'); // в памяти, не persist:party
  ses.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  const w = new BrowserWindow({
    show: false, width: 400, height: 300,
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      ...(discord ? { preload: path.join(repo, 'party-preload.js'), nodeIntegrationInSubFrames: true } : {}), // как makePartyWin
    },
  });
  w.cspBlocked = 0; // сколько раз CSP страницы что-то не пустил (событие securitypolicyviolation для ворклетов не приходит)
  w.webContents.on('console-message', (e) => {
    if (/Content Security Policy/.test(e.message)) w.cspBlocked++;
    else if (e.level === 'error') console.log('  [страница]', e.message);
  });
  current = w;
  return w;
}
async function load(w, url) {
  await w.loadURL(url);
  await wait(300);
}
// Страница отвечает не дольше 20 с: зависший probe — провал, а не вечное ожидание
const run = (frame, code) => Promise.race([frame.executeJavaScript(code), wait(20000).then(() => { throw new Error('страница не ответила: ' + code); })]);
async function close(w) {
  w.destroy();
  await wait(500);
}

app.whenReady().then(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // 1. Режим включён, звонок на самой странице
    let w = makeWin(true);
    await load(w, base + '/top');
    let r = await run(w.webContents.mainFrame, `probe(${TONE}, {})`);
    ok('страница: getUserMedia подменён', r.native === false, r.native);
    ok('страница: в микрофоне сайта есть звук Discord (тон)', r.toneDb >= 20, r.toneDb);
    ok('страница: дорожка называется как микрофон', !!r.label && r.label.length > 0, r.label);
    ok('страница: deviceId из getSettings — настоящего микрофона', !!r.deviceId, r.deviceId);
    ok('страница: остановка дорожки останавливает настоящий микрофон', r.ownStop && r.stoppedThroughPrototype.length === 1 && r.state === 'ended', [r.stoppedThroughPrototype, r.state]);
    console.log('     поддельный микрофон: пик ' + r.micPeakHz + ' Гц, ' + r.micPeakDb + ' дБ над фоном; входов ' + r.inputs);
    const micPeak = r;
    ok('страница: голос (поддельный микрофон) тоже в смеси', r.micPeakDb >= 10, r.micPeakDb);
    ok('страница: подписка снята после остановки', await (async () => { await wait(200); return feed.size === 0; })(), feed.size);

    // 1b. deviceId exact и видео заодно
    r = await run(w.webContents.mainFrame, `probe(${TONE}, { byId: true, video: true })`);
    ok('deviceId exact: работает, getSettings отдаёт тот же', !!r.deviceIdAsked && r.deviceId === r.deviceIdAsked, [r.deviceIdAsked, r.deviceId]);
    ok('видео проходит как есть, аудио одно', r.videoTracks === 1 && r.audioTracks === 1, [r.videoTracks, r.audioTracks]);
    ok('deviceId + видео: тон есть', r.toneDb >= 20, r.toneDb);
    await close(w);

    // 2. Звонок в iframe с другого origin (свой процесс)
    w = makeWin(true);
    await load(w, base + '/frame-host');
    await wait(500);
    const frame = w.webContents.mainFrame.framesInSubtree.find((f) => f !== w.webContents.mainFrame && f.url.startsWith(`http://localhost:${port}`));
    ok('iframe: загружен', !!frame);
    if (frame) {
      console.log('     iframe в отдельном процессе: ' + (frame.processId !== w.webContents.mainFrame.processId));
      r = await run(frame, `probe(${TONE}, {})`);
      ok('iframe: getUserMedia подменён', r.native === false, r.native);
      ok('iframe: в микрофоне есть звук Discord', r.toneDb >= 20, r.toneDb);
    }
    await close(w);

    // 3. Строгий CSP: blob: и data: для AudioWorklet запрещены — запасной путь (цепочка буферов)
    w = makeWin(true);
    await load(w, base + '/csp');
    r = await run(w.webContents.mainFrame, `probe(${TONE}, {})`);
    ok('CSP: getUserMedia подменён', r.native === false, r.native);
    ok('CSP: AudioWorklet не пущен (запасной путь)', w.cspBlocked === 1, w.cspBlocked);
    ok('CSP: тон есть и без AudioWorklet', r.toneDb >= 20, r.toneDb);
    await close(w);

    // 4. Режим выключен: preload нет, всё родное
    w = makeWin(false);
    await load(w, base + '/top');
    r = await run(w.webContents.mainFrame, `probe(${TONE}, {})`);
    ok('без режима: getUserMedia родной', r.native === true, r.native);
    ok('без режима: тона нет', r.toneDb < 6, r.toneDb);
    ok('без режима: голос на месте', Math.abs(r.micPeakHz - micPeak.micPeakHz) < 30 && r.micPeakDb >= 10, [r.micPeakHz, r.micPeakDb]);
    ok('без режима: подписок нет', feed.size === 0, feed.size);
    await close(w);
  } catch (e) {
    failed++;
    console.log('FAIL ' + (e && e.stack || e));
  }
  console.log((failed ? 'НЕ ПРОШЛО: ' + failed : 'всё прошло') + ' · проверок: ' + (passed + failed));
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  app.exit(failed ? 1 : 0);
});

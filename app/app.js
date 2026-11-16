const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TEST = new URLSearchParams(location.search).has('test');
const PROBE = new URLSearchParams(location.search).has('probe');
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PARAMS = [
  { id: 'warmth', name: 'Тепло', hint: 'Низ и тело голоса' },
  { id: 'clarity', name: 'Ясность', hint: 'Разборчивость, голос выходит вперёд' },
  { id: 'air', name: 'Воздух', hint: 'Блеск и дыхание на верхах' },
  { id: 'density', name: 'Плотность', hint: 'Ровный, «дикторский» звук' },
  { id: 'width', name: 'Объём', hint: 'Ширина в стерео' },
  { id: 'space', name: 'Пространство', hint: 'Лёгкая комната вокруг голоса' },
  { id: 'clean', name: 'Тишина в паузах', hint: 'Глушит фон, пока вы молчите' },
  { id: 'deess', name: 'Мягкие «с» и «ш»', hint: 'Убирает резкие свистящие' },
];

const PRESETS = {
  studio: { name: 'Студия', hue: 212, v: { warmth: 55, clarity: 50, air: 45, density: 55, width: 35, space: 12, clean: 45, deess: 50 } },
  radio: { name: 'Радио', hue: 28, v: { warmth: 75, clarity: 65, air: 35, density: 85, width: 20, space: 5, clean: 55, deess: 60 } },
  velvet: { name: 'Бархат', hue: 278, v: { warmth: 90, clarity: 30, air: 25, density: 60, width: 45, space: 20, clean: 45, deess: 70 } },
  crystal: { name: 'Кристалл', hue: 176, v: { warmth: 30, clarity: 75, air: 80, density: 45, width: 50, space: 18, clean: 50, deess: 65 } },
  cinema: { name: 'Кино', hue: 348, v: { warmth: 80, clarity: 45, air: 40, density: 70, width: 70, space: 40, clean: 40, deess: 55 } },
  whisper: { name: 'Шёпот', hue: 140, v: { warmth: 45, clarity: 55, air: 90, density: 95, width: 60, space: 10, clean: 15, deess: 80 } },
};

const STORE_KEY = 'aura.state.v1';
const DEFAULTS = {
  on: false,
  preset: 'studio',
  v: { ...PRESETS.studio.v },
  inGain: 0,
  outGain: 0,
  auto: true,
  ns: false,
  monitor: false,
  inputId: '',
  outputId: undefined, // undefined = never chosen → auto-detect a virtual cable
  monitorId: '',
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    return { ...DEFAULTS, ...saved, v: { ...DEFAULTS.v, ...saved?.v } };
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const state = loadState();
if (TEST || PROBE) state.on = true;
const save = () => {
  if (!TEST && !PROBE) localStorage.setItem(STORE_KEY, JSON.stringify(state));
};

const engine = new Engine();
let devices = [];
let busy = false;

/* ───────── System module (APO inside the microphone) ─────────
 * When it is installed, Windows itself runs the voice chain inside the microphone,
 * so every program hears the processed voice. This window then only sends settings. */
let sys = { available: false, installed: false, alive: false };
let sysMessage = '';
let sysBusy = false;
let holdingOriginal = false;
let recording = false;
let onSince = 0;
let startFailed = false; // the microphone would not open while the module is installed

function pushSystem() {
  if (!sys.installed || TEST) return;
  // Off, "hold to compare" and sample recording all want the untouched microphone.
  const enabled = state.on && !holdingOriginal && !recording;
  const v = state.v;
  window.auraSystem.write(
    [
      `enabled=${enabled ? 1 : 0}`,
      ...Object.keys(v).map((k) => `${k}=${v[k]}`),
      `auto=${state.auto ? 1 : 0}`,
      `ns=${state.ns ? 1 : 0}`,
      `ingain=${state.inGain}`,
      `outgain=${state.outGain}`,
    ].join('\r\n') + '\r\n'
  );
}

function applyAll() {
  engine.apply(state);
  pushSystem();
}

// In system mode the live path must pass the microphone through untouched (it is already processed);
// the in-app chain is only used to audition a recorded sample.
function syncBypass() {
  if (sys.installed) engine.setBypass(!engine.sampleMode);
}

async function pollSystem() {
  if (!window.auraSystem || TEST) return;
  const before = sys.installed;
  sys = await window.auraSystem.status();
  if (sys.installed !== before) {
    $('#outputId').disabled = sys.installed;
    if (engine.running) await restartEngine();
    pushSystem();
    renderRoute();
  }
  renderSystem();
  if (engine.running) liveStatus();
}

async function restartEngine() {
  await engine.stop();
  await setPower(true);
}

function renderSystem() {
  const card = $('#systemCard');
  const btn = $('#sysBtn');
  const alt = $('#sysAlt');
  card.hidden = !sys.available && !sys.installed;
  if (card.hidden) return;

  // Give Windows a few seconds to load the module before calling it a failure.
  const silent = sys.installed && (startFailed || (engine.running && !engine.sampleMode && !sys.alive && Date.now() - onSince > 6000));
  let title, text, action;
  if (!sys.installed) {
    title = 'Встроить Aura в микрофон';
    text = 'Обработанный голос услышат все программы — без виртуального кабеля. Windows спросит права администратора, звук в системе прервётся на пару секунд.';
    action = 'Встроить';
  } else if (silent) {
    title = 'Windows не запустила модуль';
    text = 'Пока модуль в таком состоянии, микрофон может не работать и в других программах. «Убрать» вернёт микрофон как был; после этого модуль можно встроить заново.';
    action = 'Убрать';
  } else {
    title = 'Aura встроена в микрофон';
    text = sys.alive ? 'Модуль работает. Голос остаётся обработанным, даже когда это окно закрыто.' : 'Включите сферу, чтобы проверить, что модуль работает.';
    action = 'Убрать';
  }
  card.classList.toggle('warn', silent);
  $('#sysTitle').textContent = title;
  $('#sysText').textContent = sysMessage || text;
  btn.textContent = sysBusy ? 'Подождите…' : action;
  btn.disabled = alt.disabled = sysBusy;
  alt.hidden = true;
  btn.dataset.action = sys.installed ? 'uninstall' : 'install';
}

async function runSetup(action) {
  if (sysBusy) return;
  sysBusy = true;
  sysMessage = 'Подтвердите запрос Windows…';
  renderSystem();
  const wasOn = engine.running;
  if (wasOn) await engine.stop(); // the audio service is about to restart under us
  const res = await window.auraSystem.setup(action === 'uninstall' ? 'uninstall' : 'install', action === 'unprotect');
  sysMessage = res.cancelled ? 'Отменено — ничего не изменилось.' : res.lines.join(' ') || (res.ok ? '' : 'Установщик не ответил.');
  sysBusy = false;
  startFailed = false;
  await new Promise((r) => setTimeout(r, 1500)); // let the audio service come back
  await pollSystem();
  if (wasOn) await setPower(true);
  renderPower();
  setTimeout(() => {
    sysMessage = '';
    renderSystem();
  }, 9000);
}
$('#sysBtn').addEventListener('click', (e) => runSetup(e.currentTarget.dataset.action));
$('#sysAlt').addEventListener('click', () => runSetup('uninstall'));

/* ───────── Status ───────── */
const statusEl = $('#status');
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}
function liveStatus() {
  if (!engine.running) return setStatus('Нажмите на сферу, чтобы включить');
  if (engine.sampleMode) return setStatus('Играет проба — настраивайте звук');
  const c = engine.ctx;
  // +12 ms: look-ahead of the compressor and the limiter.
  if (sys.installed) return setStatus(sys.alive ? `В эфире · встроено в микрофон, ${state.ns ? 'задержка 10 мс' : 'без задержки'}` : 'В эфире · жду ответа модуля…');
  const ms = Math.round((c.baseLatency + (c.outputLatency || 0)) * 1000 + 12);
  setStatus(`В эфире · задержка около ${ms} мс`);
}

/* ───────── Power ───────── */
const powerBtn = $('#power');
async function setPower(on) {
  if (busy) return;
  busy = true;
  try {
    if (on && !engine.running) {
      setStatus('Запускаю…');
      await engine.start(state, { test: TEST, system: sys.installed });
      onSince = Date.now();
      startFailed = false;
      syncBypass();
      await refreshDevices();
    } else if (!on && engine.running) {
      await engine.stop();
    }
    state.on = on;
  } catch (err) {
    console.error('engine start failed:', err?.name, err?.message);
    await engine.stop().catch(() => {});
    state.on = false;
    const denied = err?.name === 'NotAllowedError' || err?.name === 'NotFoundError';
    startFailed = sys.installed && !denied;
    setStatus(startFailed ? 'Микрофон не открывается: Windows не смогла запустить модуль Aura.' : denied ? 'Нет доступа к микрофону. Проверьте, что он подключён и разрешён в Windows.' : `Не удалось запустить звук: ${err?.message || err}`, true);
  }
  busy = false;
  save();
  pushSystem();
  renderPower();
  renderSystem();
}
// Keep the tray icon and its menu in step with the window.
function reportToTray() {
  window.auraSystem?.report({
    on: engine.running,
    preset: state.preset,
    presetName: PRESETS[state.preset]?.name || '',
    presets: Object.entries(PRESETS).map(([id, p]) => ({ id, name: p.name })),
  });
}
function renderPower() {
  const on = engine.running;
  reportToTray();
  document.body.classList.toggle('on', on);
  powerBtn.setAttribute('aria-pressed', String(on));
  powerBtn.setAttribute('aria-label', on ? 'Выключить обработку голоса' : 'Включить обработку голоса');
  $('#compare').disabled = !on;
  $('#sample').disabled = !on;
  renderSample();
  if (on || !statusEl.classList.contains('error')) liveStatus();
}
powerBtn.addEventListener('click', () => setPower(!engine.running));

/* ───────── Presets ───────── */
const presetsEl = $('#presets');
for (const [id, p] of Object.entries(PRESETS)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = p.name;
  b.dataset.id = id;
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => selectPreset(id));
  presetsEl.append(b);
}
function selectPreset(id) {
  if (!PRESETS[id]) return;
  state.preset = id;
  state.v = { ...PRESETS[id].v };
  renderPreset();
  renderSliders();
  applyAll();
  save();
  reportToTray();
}
function renderPreset() {
  const p = PRESETS[state.preset] || PRESETS.studio;
  for (const b of presetsEl.children) b.setAttribute('aria-checked', String(b.dataset.id === state.preset));
  $('#presetTitle').textContent = p.name;
  document.documentElement.style.setProperty('--hue', p.hue);
}

/* ───────── Sliders ───────── */
const fill = (input) => {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
};
const slidersEl = $('#sliders');
const sliderInputs = {};
for (const p of PARAMS) {
  const label = document.createElement('label');
  label.className = 'slider';
  label.innerHTML = `<span><b>${p.name}</b><em></em></span><input type="range" min="0" max="100" step="1"><small>${p.hint}</small>`;
  const input = label.querySelector('input');
  const value = label.querySelector('em');
  input.addEventListener('input', () => {
    state.v[p.id] = Number(input.value);
    value.textContent = input.value;
    fill(input);
    applyAll();
    save();
  });
  sliderInputs[p.id] = { input, value };
  slidersEl.append(label);
}
function renderSliders() {
  for (const p of PARAMS) {
    const { input, value } = sliderInputs[p.id];
    input.value = state.v[p.id];
    value.textContent = state.v[p.id];
    fill(input);
  }
}

const signed = (db) => `${db > 0 ? '+' : ''}${db} дБ`;
for (const id of ['inGain', 'outGain']) {
  const input = $(`#${id}`);
  const render = () => {
    $(`#${id}Val`).textContent = signed(state[id]);
    fill(input);
  };
  input.value = state[id];
  render();
  input.addEventListener('input', () => {
    state[id] = Number(input.value);
    render();
    applyAll();
    save();
  });
}

/* ───────── Switches ───────── */
for (const id of ['auto', 'ns', 'monitor']) {
  const box = $(`#${id}`);
  box.checked = state[id];
  box.addEventListener('change', async () => {
    state[id] = box.checked;
    save();
    applyAll();
    // Noise suppression is a property of the capture itself — the microphone must be reopened.
    if (id === 'ns' && engine.running && !TEST && !sys.installed) await engine.openMic(state).catch(() => {});
    if (id === 'ns') liveStatus();
  });
}

/* ───────── Devices ───────── */
const VIRTUAL = [
  { re: /cable input/i, mic: 'CABLE Output' },
  { re: /voicemeeter input/i, mic: 'VoiceMeeter Output' },
  { re: /steam streaming speakers/i, mic: 'Steam Streaming Microphone' },
];
const real = (d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications';
const cleanLabel = (d) => d.label.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '') || 'Устройство без названия';

function fillSelect(el, items, selected, firstLabel) {
  el.replaceChildren(new Option(firstLabel, ''), ...items.map((d) => new Option(cleanLabel(d), d.deviceId)));
  el.value = items.some((d) => d.deviceId === selected) ? selected : '';
}

async function refreshDevices() {
  devices = (await navigator.mediaDevices.enumerateDevices()).filter(real);
  const inputs = devices.filter((d) => d.kind === 'audioinput');
  const outputs = devices.filter((d) => d.kind === 'audiooutput');

  if (state.outputId === undefined && outputs.some((d) => d.label)) {
    const found = VIRTUAL.map((v) => outputs.find((d) => v.re.test(d.label))).find(Boolean);
    state.outputId = found ? found.deviceId : '';
    save();
    if (engine.running && !TEST) await engine.setOutput(state.outputId);
  }

  fillSelect($('#inputId'), inputs, state.inputId, 'Системный по умолчанию');
  fillSelect($('#outputId'), outputs, state.outputId, 'Не выбран');
  fillSelect($('#monitorId'), outputs, state.monitorId, 'Системные по умолчанию');
  renderRoute();
}

function renderRoute() {
  const el = $('#route');
  if (sys.installed) {
    el.classList.remove('warn');
    el.textContent = 'Aura встроена в микрофон: в Discord, OBS и играх ничего переключать не нужно, выбирайте свой обычный микрофон.';
    return;
  }
  const out = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === state.outputId);
  el.classList.toggle('warn', !out);
  if (!out) {
    el.textContent = 'Выберите «Выход в приложения» — виртуальное аудиоустройство, через которое голос попадёт в Discord, OBS и игры. Если такого нет, установите бесплатный VB-CABLE и выберите здесь «CABLE Input».';
    return;
  }
  const virtual = VIRTUAL.find((v) => v.re.test(out.label));
  el.textContent = virtual
    ? `Готово: в Discord, OBS или игре выберите микрофон «${virtual.mic}» — туда идёт уже обработанный голос.`
    : `Голос идёт в «${cleanLabel(out)}». Если это колонки или наушники, собеседники его не услышат — нужен виртуальный кабель (например, VB-CABLE).`;
}

$('#inputId').addEventListener('change', async (e) => {
  state.inputId = e.target.value;
  save();
  if (engine.running && !TEST) await engine.openMic(state).catch(() => setStatus('Не удалось открыть этот микрофон', true));
});
$('#outputId').addEventListener('change', async (e) => {
  state.outputId = e.target.value;
  save();
  await engine.setOutput(state.outputId);
  renderRoute();
  liveStatus();
});
$('#monitorId').addEventListener('change', async (e) => {
  state.monitorId = e.target.value;
  save();
  await engine.setMonitorDevice(state.monitorId);
});
navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

/* ───────── Compare (hold) ───────── */
const compareBtn = $('#compare');
const holdCompare = (on) => {
  compareBtn.classList.toggle('held', on);
  if (sys.installed && !engine.sampleMode) {
    // The processing lives in the microphone: switch it off there for as long as the button is held.
    holdingOriginal = on;
    pushSystem();
  } else {
    engine.setBypass(on);
  }
};
compareBtn.addEventListener('pointerdown', (e) => {
  compareBtn.setPointerCapture(e.pointerId);
  holdCompare(true);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) compareBtn.addEventListener(ev, () => holdCompare(false));
compareBtn.addEventListener('keydown', (e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && holdCompare(true));
compareBtn.addEventListener('keyup', () => holdCompare(false));
compareBtn.addEventListener('blur', () => holdCompare(false));

/* ───────── Sample loop ───────── */
const sampleBtn = $('#sample');
function renderSample() {
  sampleBtn.classList.toggle('live', engine.sampleMode || recording);
  if (!recording) sampleBtn.textContent = engine.sampleMode ? 'Остановить пробу' : 'Записать пробу';
}
sampleBtn.addEventListener('click', async () => {
  if (recording || !engine.running) return;
  if (engine.sampleMode) {
    engine.stopSample();
  } else {
    recording = true;
    renderSample();
    if (sys.installed) {
      // Record the raw microphone: the module steps aside, then the sample is auditioned through the in-app chain.
      pushSystem();
      await new Promise((r) => setTimeout(r, 400));
    }
    setStatus('Говорите — идёт запись');
    try {
      await engine.recordSample(6, (s) => (sampleBtn.textContent = `Запись… ${s}`));
      engine.playSample();
    } catch (err) {
      console.error('sample failed:', err?.message);
    }
    recording = false;
  }
  syncBypass();
  pushSystem();
  renderSample();
  liveStatus();
});

/* ───────── Orb + meters ───────── */
const cv = $('#orb');
const g = cv.getContext('2d');
const DPR = Math.min(devicePixelRatio || 1, 2);
cv.width = cv.height = 260 * DPR;
const bands = new Float32Array(12);
let level = 0;
let energy = 0;
let hue = PRESETS[state.preset]?.hue ?? 212;
let rot = 0;

const meterEls = { in: [$('#mIn'), $('#mInDb')], out: [$('#mOut'), $('#mOutDb')], gr: [$('#mGr'), $('#mGrDb')] };
function setMeter([bar, text], frac, label) {
  bar.style.transform = `scaleX(${clamp(frac, 0, 1).toFixed(3)})`;
  text.textContent = label;
}
const dbLabel = (db) => (db < -70 ? '—' : `${Math.round(db)} дБ`);

let lastText = 0;
function frame(now) {
  const m = engine.meters();
  const target = m ? clamp((m.out + 55) / 45, 0, 1) : 0;
  level += (target - level) * (target > level ? 0.35 : 0.1);
  energy += ((m ? 1 : 0) - energy) * 0.08;

  const wantHue = PRESETS[state.preset]?.hue ?? 212;
  hue += ((((wantHue - hue) % 360) + 540) % 360 - 180) * 0.08;

  for (let b = 0; b < bands.length; b++) {
    let x = 0;
    if (m) {
      for (let i = 0; i < 5; i++) x += m.spectrum[2 + b * 5 + i];
      x /= 5 * 255;
    }
    bands[b] += (x - bands[b]) * 0.25;
  }
  if (!REDUCED_MOTION) rot += 0.004 + level * 0.012;
  drawOrb();

  if (m) {
    const inFrac = (m.in + 60) / 60;
    const outFrac = (m.out + 60) / 60;
    const grFrac = -m.reduction / 20;
    const text = now - lastText > 120; // numbers at ~8 fps stay readable
    if (text) lastText = now;
    setMeter(meterEls.in, inFrac, text ? dbLabel(m.in) : meterEls.in[1].textContent);
    setMeter(meterEls.out, outFrac, text ? dbLabel(m.out) : meterEls.out[1].textContent);
    // In system mode the compressor runs inside the microphone, out of this window's sight.
    if (sys.installed && !engine.sampleMode) setMeter(meterEls.gr, 0, '—');
    else setMeter(meterEls.gr, grFrac, text ? `${m.reduction.toFixed(1)} дБ` : meterEls.gr[1].textContent);
  } else if (meterEls.in[1].textContent !== '—') {
    for (const k of Object.values(meterEls)) setMeter(k, 0, '—');
  }
  requestAnimationFrame(frame);
}

function drawOrb() {
  const W = cv.width;
  const c = W / 2;
  const R = W * 0.25 * (1 + level * 0.2);
  const sat = 8 + 87 * energy;
  g.clearRect(0, 0, W, W);
  g.globalCompositeOperation = 'lighter';

  const halo = g.createRadialGradient(c, c, R * 0.5, c, c, W / 2);
  halo.addColorStop(0, `hsla(${hue}, ${sat}%, 60%, ${0.1 + 0.3 * energy + 0.2 * level})`);
  halo.addColorStop(1, `hsla(${hue}, ${sat}%, 60%, 0)`);
  g.fillStyle = halo;
  g.fillRect(0, 0, W, W);

  for (let k = 0; k < 3; k++) {
    const r0 = R * (1 + k * 0.07);
    g.beginPath();
    for (let i = 0; i <= 120; i++) {
      const a = (i / 120) * Math.PI * 2;
      const wob =
        bands[1 + k] * Math.sin(2 * a + rot * 1.3 + k) +
        bands[4 + k] * Math.sin(3 * a - rot * 1.7 + k * 2) +
        bands[8 + k] * Math.sin(5 * a + rot * 2.3 + k * 3);
      const r = r0 * (1 + 0.24 * wob);
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
    const h = hue + (k - 1) * 30;
    const body = g.createRadialGradient(c, c, 0, c, c, r0 * 1.3);
    body.addColorStop(0, `hsla(${h}, ${sat}%, 72%, ${0.22 + 0.3 * energy})`);
    body.addColorStop(0.7, `hsla(${h}, ${sat}%, 56%, ${0.14 + 0.2 * energy})`);
    body.addColorStop(1, `hsla(${h - 20}, ${sat}%, 45%, 0.02)`);
    g.fillStyle = body;
    g.fill();
  }

  // Specular highlight — makes the blob read as a glass sphere.
  const shine = g.createRadialGradient(c - R * 0.35, c - R * 0.45, 0, c - R * 0.35, c - R * 0.45, R * 0.9);
  shine.addColorStop(0, `rgba(255, 255, 255, ${0.16 + 0.14 * energy})`);
  shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.fillStyle = shine;
  g.beginPath();
  g.arc(c, c, R, 0, Math.PI * 2);
  g.fill();
}

/* ───────── Boot ───────── */
async function boot() {
  renderPreset();
  renderSliders();
  renderPower();
  requestAnimationFrame(frame);

  if (!TEST) {
    // Device names are hidden until the microphone has been opened once.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  await refreshDevices();
  await pollSystem();
  setInterval(pollSystem, 2000);
  window.auraSystem?.onCommand((name, arg) => {
    if (name === 'power') setPower(!engine.running);
    if (name === 'preset') selectPreset(arg);
  });
  if (state.on) await setPower(true);

  if (TEST) {
    setTimeout(() => {
      const m = engine.meters();
      const c = engine.ctx;
      console.log(
        `selftest ctx=${c?.state} sr=${c?.sampleRate} base=${((c?.baseLatency || 0) * 1000).toFixed(1)}ms ` +
          `in=${m?.in.toFixed(1)}dB out=${m?.out.toFixed(1)}dB gr=${m?.reduction.toFixed(1)}dB ` +
          `devices=${devices.map((d) => `${d.kind}:${cleanLabel(d)}`).join(' | ')}`
      );
    }, 2500);
  }
}
boot();

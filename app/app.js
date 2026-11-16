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
  { id: 'deess', name: 'Мягкие «с» и «ш»', hint: 'Убирает резкие свистящие' },
  { id: 'pitch', name: 'Тон голоса', hint: 'Ниже или выше, в полутонах', min: -12, max: 12, format: (v) => (v > 0 ? `+${v}` : String(v)) },
  // These two describe your room and your microphone technique, not a character, so presets leave them alone.
  { id: 'clean', name: 'Тишина в паузах', hint: 'Глушит фон, пока вы молчите', global: true },
  { id: 'ns', name: 'Шумоподавление', hint: 'Нейросеть: до 60 чистит фон, выше — глушит всё, кроме голоса', global: true },
  { id: 'pop', name: 'Анти-хлопок', hint: 'Смягчает удары «п» и «б» в микрофон', global: true },
  { id: 'dereverb', name: 'Эхо комнаты', hint: 'Убирает гулкость помещения', global: true },
];

const PRESETS = {
  studio: { name: 'Студия', hue: 212, v: { warmth: 55, clarity: 50, air: 45, density: 55, width: 35, space: 12, clean: 45, deess: 50, pitch: 0 } },
  radio: { name: 'Радио', hue: 28, v: { warmth: 75, clarity: 65, air: 35, density: 85, width: 20, space: 5, clean: 55, deess: 60, pitch: 0 } },
  velvet: { name: 'Бархат', hue: 278, v: { warmth: 90, clarity: 30, air: 25, density: 60, width: 45, space: 20, clean: 45, deess: 70, pitch: 0 } },
  crystal: { name: 'Кристалл', hue: 176, v: { warmth: 30, clarity: 75, air: 80, density: 45, width: 50, space: 18, clean: 50, deess: 65, pitch: 0 } },
  cinema: { name: 'Кино', hue: 348, v: { warmth: 80, clarity: 45, air: 40, density: 70, width: 70, space: 40, clean: 40, deess: 55, pitch: 0 } },
  whisper: { name: 'Шёпот', hue: 140, v: { warmth: 45, clarity: 55, air: 90, density: 95, width: 60, space: 10, clean: 15, deess: 80, pitch: 0 } },
  custom: { name: 'Свой', hue: 44, v: null }, // whatever the user last dialled in by hand
};

const STORE_KEY = 'aura.state.v1';
const DEFAULTS = {
  on: false,
  preset: 'studio',
  v: { ...PRESETS.studio.v },
  inGain: 0,
  outGain: 0,
  auto: true,
  g: { ns: 0, pop: 50, clean: 45, dereverb: 0 },
  custom: null,
  mute: false,
  nsEngine: 0, // 0 = fast (RNNoise), 1 = high quality (DeepFilterNet)
  pads: [], // soundboard: [{ id: stored file name, name }]
  playId: 0,
  playStop: 0,
  clipGain: 70,
  monitor: false,
  inputId: '',
  outputId: undefined, // undefined = never chosen → auto-detect a virtual cable
  monitorId: '',
};

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    const g = { ...DEFAULTS.g, ...saved?.g };
    if (saved?.ns === true && !saved.g) g.ns = 60; // older builds had an on/off switch
    return { ...DEFAULTS, ...saved, g, v: { ...DEFAULTS.v, ...saved?.v } };
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
      `clean=${state.g.clean}`, // after the preset values: the last one wins
      `ns=${state.g.ns}`,
      `nsengine=${state.nsEngine}`,
      `playid=${state.playId}`,
      `playstop=${state.playStop}`,
      `clipgain=${state.clipGain}`,
      `pop=${state.g.pop}`,
      `dereverb=${state.g.dereverb}`,
      `mute=${state.mute ? 1 : 0}`,
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
    $('#mute').disabled = !sys.installed; // only the module can silence the microphone for every program
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
  if (sys.detached) {
    title = 'Windows отключила модуль';
    text = 'Так бывает после обновления Windows или драйвера микрофона. Встройте модуль заново — настройки сохранятся.';
    action = 'Встроить заново';
  } else if (!sys.installed) {
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
  card.classList.toggle('warn', silent || !!sys.detached);
  // The card lives on the Settings page: flag the tab when it needs attention.
  tabButtons.find((b) => b.dataset.tab === 'setup').classList.toggle('attention', silent || !!sys.detached);
  $('#sysTitle').textContent = title;
  $('#sysText').textContent = sysMessage || text;
  btn.textContent = sysBusy ? 'Подождите…' : action;
  btn.disabled = alt.disabled = sysBusy;
  alt.hidden = true;
  btn.dataset.action = sys.installed && !sys.detached ? 'uninstall' : 'install';
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
// What the optional stages cost: each one has to look a little way ahead.
function latencyText() {
  const deep = state.nsEngine === 1 && moduleLevels?.engine === 1;
  const ms = (state.g.ns > 0 ? (deep ? 30 : 10) : 0) + (state.g.dereverb > 0 ? 5 : 0) + (state.v.pitch ? 22 : 0);
  return ms ? `задержка около ${ms} мс` : 'без задержки';
}
function liveStatus() {
  if (!engine.running) return setStatus('Нажмите на сферу, чтобы включить');
  if (engine.sampleMode) return setStatus('Играет проба — настраивайте звук');
  const c = engine.ctx;
  // +12 ms: look-ahead of the compressor and the limiter.
  if (sys.installed) return setStatus(sys.alive ? `В эфире · встроено в микрофон, ${latencyText()}` : 'В эфире · жду ответа модуля…');
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
    mute: state.mute && sys.installed,
    system: sys.installed,
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
  $('#tune').disabled = !on;
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
  state.v = { pitch: 0, ...(id === 'custom' ? state.custom || state.v : PRESETS[id].v) };
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

/* ───────── Preset files ───────── */
const flash = (text, isError = false) => {
  setStatus(text, isError);
  setTimeout(liveStatus, 4000);
};
$('#presetSave').addEventListener('click', async () => {
  const saved = await window.auraSystem.exportPreset({ app: 'aura', version: 1, name: PRESETS[state.preset]?.name || 'Свой', v: state.v });
  if (saved) flash('Пресет сохранён в файл');
});
$('#presetLoad').addEventListener('click', async () => {
  const data = await window.auraSystem.importPreset();
  if (!data) return;
  if (data.error) return flash('Это не файл пресета Aura', true);
  // Only the character travels in a file; room settings (noise, echo, gate) stay yours.
  const v = {};
  for (const p of PARAMS.filter((q) => !q.global)) {
    const n = Number(data.v[p.id]);
    v[p.id] = Number.isFinite(n) ? clamp(Math.round(n), p.min ?? 0, p.max ?? 100) : PRESETS.studio.v[p.id];
  }
  state.custom = v;
  selectPreset('custom');
  flash('Пресет загружен в «Свой»');
});

/* ───────── Sliders ───────── */
const fill = (input) => {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
};
const slidersEl = $('#sliders');
const sliderInputs = {};
const bank = (p) => (p.global ? state.g : state.v);
const show = (p, v) => (p.format ? p.format(Number(v)) : String(v));
for (const p of PARAMS) {
  const label = document.createElement('label');
  label.className = 'slider';
  label.innerHTML = `<span><b>${p.name}</b><em></em></span><input type="range" min="${p.min ?? 0}" max="${p.max ?? 100}" step="1"><small>${p.hint}</small>`;
  const input = label.querySelector('input');
  const value = label.querySelector('em');
  input.addEventListener('input', () => {
    bank(p)[p.id] = Number(input.value);
    value.textContent = show(p, input.value);
    fill(input);
    if (!p.global) {
      // Hand-tuning a character turns it into the user's own preset, so it is never lost.
      state.custom = { ...state.v };
      if (state.preset !== 'custom') {
        state.preset = 'custom';
        renderPreset();
        reportToTray();
      }
    }
    applyAll();
    save();
    if (p.id === 'ns' || p.id === 'dereverb' || p.id === 'pitch') liveStatus();
  });
  // Without the module, noise suppression is the browser's own and belongs to the capture: reopen the microphone.
  if (p.id === 'ns') {
    input.addEventListener('change', () => {
      if (engine.running && !TEST && !sys.installed) engine.openMic(state).catch(() => {});
    });
  }
  sliderInputs[p.id] = { input, value };
  slidersEl.append(label);
}
function renderSliders() {
  for (const p of PARAMS) {
    const { input, value } = sliderInputs[p.id];
    input.value = bank(p)[p.id] ?? 0;
    value.textContent = show(p, bank(p)[p.id] ?? 0);
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
for (const id of ['auto', 'mute', 'monitor']) {
  const box = $(`#${id}`);
  box.checked = state[id];
  box.addEventListener('change', () => {
    state[id] = box.checked;
    save();
    applyAll();
    if (id === 'mute') reportToTray();
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
    if (engine.running && !TEST && !sys.installed) await engine.setOutput(state.outputId || null);
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
  if (!sys.installed) await engine.setOutput(state.outputId || null);
  renderRoute();
  liveStatus();
});
$('#monitorId').addEventListener('change', async (e) => {
  state.monitorId = e.target.value;
  save();
  await engine.setMonitorDevice(state.monitorId);
  engine.apply(state);
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

/* ───────── Soundboard ─────────
 * A pad decodes its file to mono 48 kHz, hands it to the module (which mixes it into the
 * microphone for every program) and plays the same thing to the user's own headphones. */
const padsEl = $('#pads');
let padContext = null;
let padSource = null;

function renderPads() {
  padsEl.replaceChildren(
    ...state.pads.map((pad) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad';
      const index = state.pads.indexOf(pad);
      if (index < 9) {
        const key = document.createElement('kbd');
        key.textContent = String(index + 1);
        b.append(key);
      }
      b.append(pad.name);
      b.title = `${pad.name} — правый клик, чтобы убрать`;
      b.addEventListener('click', () => playPad(pad));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!confirm(`Убрать звук «${pad.name}»?`)) return;
        state.pads = state.pads.filter((p) => p !== pad);
        window.auraSystem.removeSound(pad.id);
        save();
        renderPads();
        renderCatalog();
      });
      return b;
    })
  );
  $('#padsEmpty').hidden = state.pads.length > 0;
  // Warm the first pads up in the background, so even their first press is instant.
  for (const pad of state.pads.slice(0, 12)) padSamples(pad).catch(() => {});
}

function stopLocalPad() {
  try {
    padSource?.stop();
  } catch {}
  padSource = null;
}

// Any audio file → mono 48 kHz, at most 20 s, normalised so every sound is equally loud.
async function decodeSound(bytes) {
  // An offline context at 48 kHz resamples whatever the file is to the rate the module wants.
  const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const length = Math.min(decoded.length, 48000 * 20);
  const mono = new Float32Array(length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const data = decoded.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i] / decoded.numberOfChannels;
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(mono[i]));
  if (peak > 0) for (let i = 0; i < length; i++) mono[i] *= 0.7 / peak;
  return mono;
}

// Play to the user's own ears only (headphones chosen in Settings). Returns the source node.
async function playLocal(mono, onEnded) {
  stopLocalPad();
  padContext ??= new AudioContext({ sampleRate: 48000 });
  await padContext.setSinkId(state.monitorId || '').catch(() => {});
  const buffer = padContext.createBuffer(1, mono.length, 48000);
  buffer.copyToChannel(mono, 0);
  const gain = padContext.createGain();
  gain.gain.value = (state.clipGain / 100) * 0.8;
  const source = padContext.createBufferSource();
  source.buffer = buffer;
  source.connect(gain).connect(padContext.destination);
  source.onended = () => {
    if (padSource === source) padSource = null;
    onEnded?.();
  };
  source.start();
  padSource = source;
  return source;
}

// Decoded pads, ready to fire: the second press of a pad costs no reading or decoding at all.
const padCache = new Map();
async function padSamples(pad) {
  if (padCache.has(pad.id)) return padCache.get(pad.id);
  const bytes = await window.auraSystem.readSound(pad.id);
  if (!bytes) return null;
  const mono = await decodeSound(bytes);
  padCache.set(pad.id, mono);
  if (padCache.size > 60) padCache.delete(padCache.keys().next().value);
  return mono;
}

// The soundboard is its own thing: it does not need voice processing switched on. The module
// mixes the sound into the microphone whenever any program is recording from it.
async function playPad(pad) {
  let mono;
  try {
    mono = await padSamples(pad);
  } catch {
    return flash('Не получилось прочитать этот файл как звук.', true);
  }
  if (!mono) return flash('Файл этого звука не найден.', true);
  playLocal(mono);
  if (!sys.installed) return flash('Звук слышите только вы: чтобы он шёл в микрофон, встройте Aura в него на вкладке «Настройки».', true);
  if (!(await window.auraSystem.writeClip(mono))) return flash('Не удалось передать звук модулю.', true);
  state.playId++;
  save();
  pushSystem();
}

$('#padAdd').addEventListener('click', async () => {
  const added = await window.auraSystem.addSounds();
  if (!added?.length) return;
  state.pads.push(...added);
  save();
  renderPads();
});
$('#padStop').addEventListener('click', () => {
  state.playStop++;
  save();
  pushSystem();
  stopLocalPad();
});
{
  const volume = $('#padVolume');
  volume.value = state.clipGain;
  fill(volume);
  volume.addEventListener('input', () => {
    state.clipGain = Number(volume.value);
    fill(volume);
    save();
    pushSystem();
  });
}

/* ───────── Catalogue (UwUpad) ─────────
 * Browse and search the site's sounds without leaving the window: listen first (only you
 * hear the preview), then one click puts the sound on a pad. */
const catalog = { feed: 'popular', query: '', items: [], total: 0, loading: false, started: false, previewing: null };
const catalogList = $('#catalogList');
const catalogNote = (text) => ($('#catalogNote').textContent = text);

async function loadCatalog(reset) {
  if (catalog.loading) return;
  catalog.loading = true;
  if (reset) catalog.items = [];
  catalogNote('Загружаю…');
  const res = await window.auraSystem.catalog({ feed: catalog.feed, query: catalog.query, offset: catalog.items.length }).catch((err) => {
    console.error('catalog failed:', err?.message);
    return null;
  });
  catalog.loading = false;
  if (!res || res.error) {
    renderCatalog();
    return catalogNote('UwUpad не отвечает. Проверьте интернет и попробуйте ещё раз.');
  }
  catalog.items.push(...res.items);
  catalog.total = res.total;
  renderCatalog();
}

function renderCatalog() {
  if (!catalog.started) return;
  const mine = new Set(state.pads.map((p) => p.source));
  catalogList.replaceChildren(
    ...catalog.items.map((item) => {
      const row = document.createElement('div');
      row.className = 'catalog-row';
      const play = document.createElement('button');
      play.type = 'button';
      play.className = 'catalog-play';
      play.setAttribute('aria-label', `Прослушать «${item.title}»`);
      play.textContent = catalog.previewing === item.id ? '■' : '▶';
      play.addEventListener('click', () => previewSound(item));
      const title = document.createElement('span');
      title.className = 'catalog-title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'catalog-meta';
      meta.textContent = [item.explicit ? '18+' : '', item.loud ? 'громкий' : '', `${item.duration} с`, `♥ ${item.likes}`].filter(Boolean).join(' · ');
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'pill small';
      const have = mine.has(`uwu:${item.id}`);
      add.textContent = have ? 'Добавлен' : 'Добавить';
      add.disabled = have;
      add.addEventListener('click', async () => {
        add.disabled = true;
        add.textContent = 'Скачиваю…';
        const pad = await window.auraSystem.catalogAdd(item);
        if (!pad) {
          add.disabled = false;
          add.textContent = 'Добавить';
          return flash('Не удалось скачать этот звук.', true);
        }
        state.pads.push(pad);
        save();
        renderPads();
        renderCatalog();
      });
      row.append(play, title, meta, add);
      return row;
    })
  );
  $('#catalogMore').hidden = !catalog.items.length || catalog.items.length >= catalog.total;
  catalogNote(catalog.items.length || catalog.loading ? '' : 'Ничего не нашлось.');
  for (const b of $('#catalogFeeds').children) {
    b.setAttribute('aria-checked', String(!catalog.query && b.dataset.feed === catalog.feed));
  }
}

async function previewSound(item) {
  if (catalog.previewing === item.id) {
    catalog.previewing = null;
    stopLocalPad();
    return renderCatalog();
  }
  catalog.previewing = item.id;
  renderCatalog();
  const done = () => {
    if (catalog.previewing === item.id) {
      catalog.previewing = null;
      renderCatalog();
    }
  };
  try {
    const bytes = await window.auraSystem.catalogSound(item);
    if (!bytes) throw new Error('no data');
    const mono = await decodeSound(bytes);
    if (catalog.previewing !== item.id) return; // the user moved on while it was downloading
    await playLocal(mono, done);
  } catch {
    done();
    flash('Не удалось проиграть этот звук.', true);
  }
}

let searchTimer = 0;
$('#catalogSearch').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    catalog.query = e.target.value.trim();
    loadCatalog(true);
  }, 450); // wait until typing pauses: one request per search, not one per letter
});
for (const b of $('#catalogFeeds').children) {
  b.addEventListener('click', () => {
    catalog.feed = b.dataset.feed;
    catalog.query = '';
    $('#catalogSearch').value = '';
    loadCatalog(true);
  });
}
$('#catalogMore').addEventListener('click', () => loadCatalog(false));
$('#catalogSite').addEventListener('click', () => window.auraSystem.openCatalogSite());

/* ───────── Pages ───────── */
const tabButtons = [...$('#tabs').children];
function showTab(name) {
  if (!tabButtons.some((b) => b.dataset.tab === name)) name = 'voice';
  for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const page of document.querySelectorAll('.page')) page.hidden = page.dataset.page !== name;
  try {
    localStorage.setItem('aura.tab', name);
  } catch {}
  if (name === 'sounds' && !catalog.started) {
    catalog.started = true; // nothing is fetched until the user actually opens the page
    loadCatalog(true);
  }
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));

/* ───────── Noise-suppression engine ───────── */
const engineSelect = $('#nsEngine');
function renderEngine() {
  const deep = moduleLevels?.deep; // 1 = available, -1 = switched off after a crash, 0/undefined = not there
  engineSelect.disabled = !sys.installed || !deep;
  engineSelect.options[1].textContent = deep === -1 ? 'Качественный — отключён после сбоя, выберите, чтобы попробовать снова' : 'Качественный — DeepFilterNet, 30 мс';
  engineSelect.value = String(state.nsEngine);
}
engineSelect.addEventListener('change', async () => {
  state.nsEngine = Number(engineSelect.value);
  if (state.nsEngine === 1) await window.auraSystem.resetDeep(); // an explicit choice clears an old crash mark
  save();
  pushSystem();
  setTimeout(liveStatus, 1500); // the module needs a moment to load the model
});

/* ───────── Auto-setup ─────────
 * Listens to the room, then to the voice, and sets input gain, the gate and noise suppression from what it heard. */
const tuneBtn = $('#tune');
let tuning = false;
async function listen(seconds, label) {
  const levels = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    setStatus(`${label} · ${Math.ceil((end - performance.now()) / 1000)}`);
    const m = engine.meters();
    if (m && m.in > -100) levels.push(m.in - state.inGain); // the raw microphone, before our own gain
    await new Promise((r) => setTimeout(r, 50));
  }
  return levels.sort((a, b) => a - b);
}
const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : -100);

tuneBtn.addEventListener('click', async () => {
  if (tuning || recording || !engine.running || engine.sampleMode) return;
  tuning = true;
  tuneBtn.classList.add('live');
  holdingOriginal = true; // measure the untouched microphone
  pushSystem();
  await new Promise((r) => setTimeout(r, 400));

  const noise = percentile(await listen(3, 'Помолчите'), 0.5);
  const speech = percentile(await listen(5, 'Говорите обычным голосом'), 0.8);
  holdingOriginal = false;
  tuning = false;
  tuneBtn.classList.remove('live');

  if (speech < noise + 6) {
    pushSystem();
    setStatus('Не расслышал голос. Попробуйте ещё раз, ближе к микрофону.', true);
    return;
  }
  // Bring the voice to a healthy working level, put the gate just above the room, and pick
  // noise suppression from how far the voice stands above the noise.
  const gain = clamp(Math.round(-26 - speech), -12, 18);
  const snr = speech - noise;
  state.g.clean = clamp(Math.round((noise + gain + 16 + 65) / 0.4), 10, 80);
  state.g.ns = snr > 45 ? 30 : snr > 30 ? 55 : 75;
  state.auto = true;
  $('#auto').checked = true;
  renderSliders();
  const gainInput = $('#inGain');
  gainInput.value = gain;
  gainInput.dispatchEvent(new Event('input')); // updates the label, applies and saves
  setStatus(`Настроено: фон ${Math.round(noise)} дБ, голос ${Math.round(speech)} дБ`);
  setTimeout(liveStatus, 6000);
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

const meterEls = { in: [$('#mIn'), $('#mInDb')], out: [$('#mOut'), $('#mOutDb')], gr: [$('#mGr'), $('#mGrDb')], lufs: [$('#mLufs'), $('#mLufsDb')] };
function setMeter([bar, text], frac, label) {
  bar.style.transform = `scaleX(${clamp(frac, 0, 1).toFixed(3)})`;
  text.textContent = label;
}
const dbLabel = (db) => (db < -70 ? '—' : `${Math.round(db)} дБ`);

// Levels reported by the module, refreshed a few times a second while it is in use.
let moduleLevels = null;
setInterval(async () => {
  if (!sys.installed || !engine.running || TEST || document.hidden) return (moduleLevels = null);
  const l = await window.auraSystem.levels();
  moduleLevels = l && Number.isFinite(l.in) ? l : null;
  renderEngine();
}, 130);

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
    const mod = sys.installed && !engine.sampleMode ? moduleLevels : null;
    if (mod) {
      // The real numbers from inside the microphone: before the chain, after it, and how hard the compressor works.
      setMeter(meterEls.in, (mod.in + 60) / 60, text ? dbLabel(mod.in) : meterEls.in[1].textContent);
      setMeter(meterEls.out, (mod.out + 60) / 60, text ? dbLabel(mod.out) : meterEls.out[1].textContent);
      setMeter(meterEls.gr, -mod.gr / 20, text ? `${mod.gr.toFixed(1)} дБ` : meterEls.gr[1].textContent);
      // Loudness as listeners perceive it; the tick on the bar is -18 LUFS, the usual target for voice.
      setMeter(meterEls.lufs, (mod.lufs + 40) / 30, text ? (mod.lufs < -60 ? '—' : `${Math.round(mod.lufs)} LUFS`) : meterEls.lufs[1].textContent);
    } else {
      setMeter(meterEls.lufs, 0, '—');
      setMeter(meterEls.in, inFrac, text ? dbLabel(m.in) : meterEls.in[1].textContent);
      setMeter(meterEls.out, outFrac, text ? dbLabel(m.out) : meterEls.out[1].textContent);
      if (sys.installed && !engine.sampleMode) setMeter(meterEls.gr, 0, '—');
      else setMeter(meterEls.gr, grFrac, text ? `${m.reduction.toFixed(1)} дБ` : meterEls.gr[1].textContent);
    }
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
  $('#mute').disabled = true; // until the module is known to be installed
  renderEngine();
  renderPads();
  let savedTab = 'voice';
  try {
    savedTab = new URLSearchParams(location.search).get('tab') || localStorage.getItem('aura.tab') || 'voice';
  } catch {}
  showTab(savedTab);
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
    if (name === 'pad' && state.pads[arg]) playPad(state.pads[arg]);
    if (name === 'mute' && sys.installed) {
      $('#mute').checked = state.mute = !state.mute;
      save();
      pushSystem();
      reportToTray();
    }
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

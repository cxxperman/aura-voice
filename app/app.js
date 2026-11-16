const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TEST = new URLSearchParams(location.search).has('test');
const PROBE = new URLSearchParams(location.search).has('probe');
const DATA = new URLSearchParams(location.search).get('data'); // dev only: worst-case fixtures, see dev-fixtures.js
let fixture = null;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PARAMS = [
  // `short` is the label under the band in the equalizer; the full name shows above it on hover.
  // Processing: everything about the voice that is not its frequency balance.
  { id: 'density', name: 'Плотность', short: 'Плотность', hint: 'Компрессор: тихое громче, громкое тише — ровный «дикторский» голос' },
  { id: 'excite', name: 'Блеск', short: 'Блеск', hint: 'Добавляет гармоники поверх голоса: звучит чётче и «дороже» даже в маленьких колонках' },
  { id: 'deess', name: 'Мягкие «с» и «ш»', short: 'Свист', hint: 'Приглушает резкие свистящие' },
  { id: 'space', name: 'Комната', short: 'Комната', hint: 'Лёгкая реверберация вокруг голоса' },
  { id: 'width', name: 'Объём', short: 'Объём', hint: 'Ширина в стерео. В звонках не слышна: там микрофон сводят в моно' },
  { id: 'pitch', name: 'Тон голоса', short: 'Тон', hint: 'Ниже или выше, в полутонах', min: -12, max: 12, format: (v) => (v > 0 ? `+${v}` : String(v)) },
  // These describe your room and your microphone technique, not a character, so presets leave them alone.
  { id: 'clean', name: 'Тишина в паузах', short: 'Паузы', hint: 'Глушит фон, пока вы молчите', global: true },
  { id: 'ns', name: 'Шумоподавление', short: 'Шум', hint: 'Нейросеть: до 60 чистит фон, выше — глушит всё, кроме голоса', global: true },
  { id: 'pop', name: 'Анти-хлопок', short: 'Хлопки', hint: 'Смягчает удары «п» и «б» в микрофон', global: true },
  { id: 'dereverb', name: 'Эхо комнаты', short: 'Эхо', hint: 'Убирает гулкость помещения', global: true },
];
// The frequency equalizer: real bands in decibels — the one place the tone of the voice is set.
// Presets move these bands; moving one by hand makes the preset «Свой».
const dbFormat = (v) => (v > 0 ? `+${v} дБ` : v < 0 ? `−${-v} дБ` : '0 дБ');
const FREQS = [
  { id: 'f100', f: 100, q: 0, name: 'Бас · 100 Гц', short: 'Бас', hint: 'Глубина и «радийный» низ. Вверх — голос басистее и крупнее' },
  { id: 'f200', f: 200, q: 1, name: 'Тело · 200 Гц', short: 'Тело', hint: 'Плотность и грудной тон. Слишком много — бубнит' },
  { id: 'f400', f: 400, q: 1.2, name: 'Коробка · 400 Гц', short: 'Коробка', hint: 'Обычно убавляют: уходит «картонный», комнатный призвук' },
  { id: 'f800', f: 800, q: 1.2, name: 'Нос · 800 Гц', short: 'Нос', hint: 'Гнусавость. Чуть убавить — голос чище' },
  { id: 'f1600', f: 1600, q: 1, name: 'Середина · 1,6 кГц', short: 'Середина', hint: 'Выводит голос вперёд; много — звучит как телефон' },
  { id: 'f3200', f: 3200, q: 1, name: 'Разборчивость · 3,2 кГц', short: 'Чёткость', hint: 'Чёткость согласных, слова читаются сквозь игру и музыку' },
  { id: 'f6000', f: 6000, q: 1.2, name: 'Яркость · 6 кГц', short: 'Яркость', hint: 'Блеск и резкость «с». Убавьте, если режет ухо' },
  { id: 'f11000', f: 11000, q: 0, name: 'Воздух · 11 кГц', short: 'Воздух', hint: 'Дорогой «студийный» верх и дыхание' },
].map((p) => ({ ...p, eq: true, min: -12, max: 12, format: dbFormat }));
PARAMS.push(...FREQS);

// A preset is a frequency curve (the eight bands, dB) plus processing. Bands left out are flat.
const PRESETS = {
  studio: { name: 'Студия', hue: 212, v: { density: 55, excite: 30, deess: 50, space: 12, width: 35, pitch: 0 }, eq: { f100: 3, f400: -2, f3200: 3, f11000: 4 } },
  radio: { name: 'Радио', hue: 28, v: { density: 85, excite: 35, deess: 60, space: 5, width: 20, pitch: 0 }, eq: { f100: 5, f200: 1, f400: -3, f1600: 1, f3200: 4, f11000: 3 } },
  velvet: { name: 'Бархат', hue: 278, v: { density: 60, excite: 15, deess: 70, space: 20, width: 45, pitch: 0 }, eq: { f100: 6, f200: 2, f400: -3, f3200: 1, f6000: -2, f11000: 2 } },
  crystal: { name: 'Кристалл', hue: 176, v: { density: 45, excite: 45, deess: 65, space: 18, width: 50, pitch: 0 }, eq: { f100: 1, f400: -2, f3200: 4, f6000: 2, f11000: 7 } },
  cinema: { name: 'Кино', hue: 348, v: { density: 70, excite: 25, deess: 55, space: 40, width: 70, pitch: 0 }, eq: { f100: 5, f200: 1, f400: -3, f800: -1, f3200: 3, f11000: 4 } },
  whisper: { name: 'Шёпот', hue: 140, v: { density: 95, excite: 40, deess: 80, space: 10, width: 60, pitch: 0 }, eq: { f100: 2, f400: -1, f3200: 3, f6000: 3, f11000: 8 } },
  custom: { name: 'Свой', hue: 44, v: null, eq: null }, // whatever the user last dialled in by hand
};

// Microphone profiles: a corrective EQ for the capsule, applied before everything else.
// Almost nobody publishes measured EQ for these microphones, so these are starting points built
// from what reviews and measurements say about each one's response (thin lows, a presence peak,
// boxiness); the measured profile that «Автонастройка» builds from your own voice is the exact one.
// A band is [frequency Hz, gain dB, Q]; Q 0 = a shelf.
const MIC_PROFILES = [
  { id: 'quadcast', name: 'HyperX QuadCast / QuadCast S', match: /quadcast/i, hp: 80, bands: [[120, 2.5, 0], [300, -1.5, 1], [1000, 1, 1.2], [7000, -1.5, 2]] },
  { id: 'solocast', name: 'HyperX SoloCast / DuoCast', match: /solocast|duocast/i, hp: 90, bands: [[130, 2, 0], [300, -2, 1], [3200, 1.5, 0.9], [7000, -1, 2]] },
  { id: 'yeti', name: 'Blue Yeti / Yeti X / Snowball', match: /yeti|snowball|blue micro/i, hp: 100, bands: [[350, -2.5, 1], [3500, 1.5, 1], [7500, -2, 2]] },
  { id: 'at2020', name: 'Audio-Technica AT2020', match: /at2020|at2040|audio-technica/i, hp: 80, bands: [[150, 2.5, 0], [300, -1.5, 1], [6000, -3, 1.2]] },
  { id: 'am8', name: 'Fifine AM8 / K688', match: /am8|k688/i, hp: 90, bands: [[500, -2.5, 1.2], [3000, 1.5, 0.9], [8000, 3, 0]] },
  { id: 'fifine', name: 'Fifine K669 / A6 и похожие', match: /fifine|k669|a6v|ampligame/i, hp: 90, bands: [[300, -2.5, 1], [3200, 1.5, 0.9], [7000, -1, 2]] },
  { id: 'podmic', name: 'Rode PodMic / PodMic USB', match: /podmic/i, hp: 70, bands: [[130, 2.5, 0], [320, -2, 1], [6000, -1.5, 1], [11000, 3, 0]] },
  { id: 'ntusb', name: 'Rode NT-USB / NT-USB Mini', match: /nt-?usb|rode/i, hp: 85, bands: [[300, -2, 1], [3200, 1, 0.9], [8000, -1.5, 2]] },
  { id: 'sm7b', name: 'Shure SM7B / MV7', match: /sm7|mv7|shure/i, hp: 80, bands: [[350, -2, 1], [3500, 2.5, 0.8], [10000, 3, 0]] },
  { id: 'wave3', name: 'Elgato Wave:1 / Wave:3', match: /wave:?\s?[13]|elgato/i, hp: 80, bands: [[130, 3, 0], [300, -1.5, 1], [3200, 1.5, 0.9]] },
  { id: 'seiren', name: 'Razer Seiren Mini / X', match: /seiren/i, hp: 90, bands: [[130, 2, 0], [300, -2, 1], [3200, 1.5, 0.9], [7500, -1, 2]] },
  { id: 'q2u', name: 'Samson Q2U / динамический USB', match: /q2u|samson|atr2100/i, hp: 80, bands: [[350, -2, 1], [3500, 2.5, 0.8], [10000, 3, 0]] },
  { id: 'maono', name: 'Maono', match: /maono/i, hp: 90, bands: [[300, -2.5, 1], [3200, 1.5, 0.9], [7000, -1, 2]] },
  { id: 'headset', name: 'Гарнитура (Cloud, Arctis, G Pro, Kraken)', match: /headset|гарнитур|cloud|arctis|g pro|g\d{3}\b|kraken|blackshark|hs\d{2}|void|virtuoso/i, hp: 110, bands: [[250, -3, 1], [600, -2, 1.4], [3000, 3, 0.9], [6500, 4, 0]] },
  { id: 'builtin', name: 'Встроенный в ноутбук или веб-камеру', match: /realtek|array|webcam|веб-кам|встроен|internal|c9\d\d|brio/i, hp: 120, bands: [[400, -3, 1], [3000, 2, 0.9], [7000, 2, 0]] },
  { id: 'condenser', name: 'Конденсаторный USB (общий)', hp: 90, bands: [[300, -2.5, 1], [3200, 1.5, 0.9], [7000, -1, 2]] },
  { id: 'dynamic', name: 'Динамический (общий)', hp: 80, bands: [[350, -2, 1], [3500, 2.5, 0.8], [10000, 3, 0]] },
];
const MIC_FLAT = { hp: 85, bands: [] };

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
  mic: 'auto', // microphone profile: 'auto' (by the device's name), 'none', 'measured', or an id from MIC_PROFILES
  micMeasured: null, // { hp, bands } built by auto-setup from the user's own voice
  eq: { ...PRESETS.studio.eq }, // frequency equalizer: band id → dB
  eqTab: 'freq', // which bank the equalizer shows: 'freq' or 'tone' (processing)
  fx: 'none', // ready voice, see VOICES
  fxCustom: { pitch: 0, formant: 0, robot: 0, drive: 0, echo: 0, space: 0, trem: 0, phone: 0 },
  fxKeys: {}, // voice id → global hotkey
  pads: [], // soundboard: [{ id: stored file name, name, source?, key? }]
  hotkeys: { power: 'Ctrl+Shift+F9', mute: 'Ctrl+Shift+F10' },
  onboarded: false,
  tuned: false,
  playId: 0,
  playStop: 0,
  clipGain: 70,
  monitor: false,
  inputId: '',
  outputId: undefined, // undefined = never chosen → auto-detect a virtual cable
  monitorId: '',
};

// Before 0.15 the tone was three macro knobs (warmth, clarity, air) inside the preset. They are
// now frequency bands: a named preset simply takes its new curve, a hand-made one is converted.
function migrateTone(s, saved) {
  const old = saved?.v;
  if (old && 'warmth' in old) {
    const named = s.preset !== 'custom' && PRESETS[s.preset]?.v;
    if (named) {
      s.v = { ...PRESETS[s.preset].v, pitch: old.pitch || 0 };
      s.eq = { ...PRESETS[s.preset].eq };
    } else {
      const add = (id, db) => (s.eq[id] = clamp(Math.round((s.eq[id] || 0) + db), -12, 12));
      add('f100', old.warmth * 0.075 - 1);
      add('f400', -old.warmth * 0.035);
      add('f3200', old.clarity * 0.06);
      add('f11000', old.air * 0.09);
      s.v = { density: old.density, excite: Math.round((old.clarity * 0.22 + old.air * 0.12) / 0.34), deess: old.deess, space: old.space, width: old.width, pitch: old.pitch || 0 };
      s.custom = { v: { ...s.v }, eq: { ...s.eq } };
    }
    s.eqTab = 'freq';
  }
  for (const k of ['warmth', 'clarity', 'air', 'clean']) delete s.v[k];
  if (s.custom && !s.custom.v) s.custom = null; // the old flat shape
  return s;
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    const g = { ...DEFAULTS.g, ...saved?.g };
    if (saved?.ns === true && !saved.g) g.ns = 60; // older builds had an on/off switch
    const merged = { ...DEFAULTS, ...saved, eq: { ...(saved?.eq || DEFAULTS.eq) }, g, v: { ...DEFAULTS.v, ...saved?.v }, hotkeys: { ...DEFAULTS.hotkeys, ...saved?.hotkeys }, fxCustom: { ...DEFAULTS.fxCustom, ...saved?.fxCustom }, fxKeys: { ...saved?.fxKeys } };
    return migrateTone(merged, saved);
  } catch {
    return structuredClone(DEFAULTS);
  }
}
const state = loadState();
if (TEST || PROBE) state.on = true;
// Debounced: a slider drag fires dozens of changes a second, and each save serialises the whole state.
let saveTimer = 0;
const flushSave = () => {
  clearTimeout(saveTimer);
  saveTimer = 0;
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
};
const save = () => {
  if (TEST || PROBE || DATA) return;
  if (!saveTimer) saveTimer = setTimeout(flushSave, 300);
};
addEventListener('pagehide', () => saveTimer && flushSave());

const engine = new Engine();
let devices = [];
let busy = false;

/* ───────── System module (APO inside the microphone) ─────────
 * When it is installed, Windows itself runs the voice chain inside the microphone,
 * so every program hears the processed voice. This window then only sends settings. */
let sys = { available: false, installed: false, alive: false };
let captureDevices = [];
let sysMessage = '';
let sysBusy = false;
let holdingOriginal = false;
let recording = false;
let onSince = 0;
let startFailed = false; // the microphone would not open while the module is installed

// The microphone the profile is for: the one the module sits in, else the one the window records.
function micName() {
  return captureDevices.find((d) => d.current)?.name || $('#inputId').selectedOptions[0]?.textContent || '';
}
function micProfile() {
  if (state.mic === 'none') return null;
  if (state.mic === 'measured') return state.micMeasured ? { name: 'По замеру вашего голоса', ...state.micMeasured } : null;
  if (state.mic === 'auto') return MIC_PROFILES.find((p) => p.match && p.match.test(micName())) || null;
  return MIC_PROFILES.find((p) => p.id === state.mic) || null;
}
function micEq() {
  return micProfile() || MIC_FLAT;
}
// Everything the corrective bank carries: the microphone profile, then the user's own frequency bands.
function eqBands() {
  const mic = micEq();
  const own = FREQS.filter((p) => state.eq[p.id]).map((p) => [p.f, state.eq[p.id], p.q]);
  return { hp: mic.hp, bands: [...mic.bands.slice(0, 6), ...own] };
}
const hzText = (f) => (f >= 1000 ? `${String(f / 1000).replace('.', ',')} кГц` : `${f} Гц`);
const dbText = (g) => `${g > 0 ? '+' : '−'}${String(Math.abs(g)).replace('.', ',')} дБ`;

function pushSystem() {
  if (!sys.installed || TEST) return;
  // Off, "hold to compare" and sample recording all want the untouched microphone.
  const enabled = state.on && !holdingOriginal && !recording;
  const v = state.v;
  window.auraSystem.write(
    [
      `enabled=${enabled ? 1 : 0}`,
      'warmth=0', 'clarity=0', 'air=0', // the tone is in the frequency bands (m…) now
      ...['density', 'excite', 'deess', 'space', 'width', 'pitch'].map((k) => `${k}=${v[k] ?? 0}`),
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
      ...Object.entries(fxValues()).map(([k, value]) => `${k}=${value}`),
      `ingain=${state.inGain}`,
      `outgain=${state.outGain}`,
      `michp=${eqBands().hp}`,
      ...Array.from({ length: 14 }, (_, i) => eqBands().bands[i] || [0, 0, 0]).flatMap(([f, g, q], i) => {
        const k = '123456789abcde'[i];
        return [`m${k}f=${f}`, `m${k}g=${g}`, `m${k}q=${q}`];
      }),
    ].join('\r\n') + '\r\n'
  );
}

function applyAll() {
  engine.apply(state, false, fxValues()); // the in-app chain mirrors the effects, so «Проба» lets you hear them
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
  setWindowVisible(sys.visible !== false);
  if (sys.installed !== before) {
    $('#outputId').disabled = sys.installed;
    $('#mute').disabled = !sys.installed; // only the module can silence the microphone for every program
    if (engine.running) await restartEngine();
    pushSystem();
    renderRoute();
  }
  renderSystem();
  if (engine.running && !recording && !tuning && performance.now() > statusHold) liveStatus();
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
  renderVoices();
  card.classList.toggle('warn', silent || !!sys.detached);
  // The card lives on the Settings page: flag the tab when it needs attention.
  tabButtons.find((b) => b.dataset.tab === 'setup').classList.toggle('attention', silent || !!sys.detached);
  $('#sysTitle').textContent = title;
  $('#sysText').textContent = sysMessage || text;
  btn.textContent = sysBusy ? 'Подождите…' : action;
  btn.disabled = alt.disabled = sysBusy;
  alt.hidden = true;
  btn.dataset.action = sys.installed && !sys.detached ? 'uninstall' : 'install';
  // Picking another microphone in the list turns the button into "move the module there".
  const select = $('#sysDevice');
  const current = captureDevices.find((d) => d.current);
  $('#sysDeviceRow').hidden = captureDevices.length === 0;
  if (sys.installed && !sys.detached && !silent && current && select.value && select.value !== current.guid && !sysBusy) {
    btn.textContent = 'Перенести сюда';
    btn.dataset.action = 'install';
  }
  renderGuide();
}

async function runSetup(action) {
  if (sysBusy) return;
  sysBusy = true;
  sysMessage = 'Подтвердите запрос Windows…';
  renderSystem();
  const wasOn = engine.running;
  if (wasOn) await engine.stop(); // the audio service is about to restart under us
  const res = await window.auraSystem.setup(action === 'uninstall' ? 'uninstall' : 'install', action === 'unprotect', $('#sysDevice').value || null);
  sysMessage = res.cancelled ? 'Отменено — ничего не изменилось.' : res.lines.join(' ') || (res.ok ? '' : 'Установщик не ответил.');
  sysBusy = false;
  startFailed = false;
  await new Promise((r) => setTimeout(r, 1500)); // let the audio service come back
  await pollSystem();
  await loadCaptureDevices();
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
let flashTimer = 0;
let statusHold = 0; // until then the 2-second poll leaves the line alone
// kind: false (plain) | true (error) | 'warn'
function setStatus(text, kind = false) {
  clearTimeout(flashTimer);
  statusHold = 0;
  statusEl.textContent = text;
  statusEl.title = text; // the line is clamped; the tooltip always has all of it
  statusEl.classList.toggle('error', kind === true);
  statusEl.classList.toggle('warn', kind === 'warn');
}
// A message that stays long enough to be read, then gives the line back to the live status.
function flash(text, kind = false, ms = kind ? 7000 : 4000) {
  setStatus(text, kind);
  statusHold = performance.now() + ms;
  flashTimer = setTimeout(liveStatus, ms);
}
// What the optional stages cost: each one has to look a little way ahead.
function latencyText() {
  const deep = state.nsEngine === 1 && moduleLevels?.engine === 1;
  const fx = fxValues();
  const shifted = (state.v.pitch || 0) + fx.fxpitch !== 0 || (fx.fxnatural && fx.fxformant !== 0);
  const ms = (state.g.ns > 0 ? (deep ? 30 : 10) : 0) + (state.g.dereverb > 0 ? 5 : 0) + (shifted ? 36 : 0);
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

// What went wrong, in words a person can act on — never a raw exception.
function friendlyError(err) {
  const known = {
    NotReadableError: 'Микрофон занят другой программой или отключён.',
    AbortError: 'Windows не дала открыть микрофон. Попробуйте ещё раз.',
    OverconstrainedError: 'Этот микрофон не поддерживает нужный режим. Выберите другой в настройках.',
  };
  return known[err?.name] || `Не удалось запустить звук: ${String(err?.message || err).slice(0, 110)}`;
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
    setStatus(startFailed ? 'Микрофон не открывается: Windows не смогла запустить модуль Aura.' : denied ? 'Нет доступа к микрофону. Проверьте, что он подключён и разрешён в Windows.' : friendlyError(err), true);
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
    voice: state.fx,
    voices: Object.entries(VOICES).map(([id, v]) => ({ id, name: v.name })),
  });
}
function renderPower() {
  const on = engine.running;
  reportToTray();
  document.body.classList.toggle('on', on);
  powerBtn.setAttribute('aria-pressed', String(on));
  powerBtn.setAttribute('aria-label', on ? 'Выключить обработку голоса' : 'Включить обработку голоса');
  if (!on) holdCompare(false);
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
  b.style.setProperty('--h', p.hue);
  b.setAttribute('role', 'radio');
  b.addEventListener('click', () => selectPreset(id));
  presetsEl.append(b);
}
function selectPreset(id) {
  if (!PRESETS[id]) return;
  state.preset = id;
  const from = id === 'custom' ? state.custom || { v: state.v, eq: state.eq } : PRESETS[id];
  state.v = { pitch: 0, ...from.v };
  state.eq = { ...from.eq };
  renderPreset();
  renderSliders(true);
  applyAll();
  save();
  reportToTray();
}
function renderPreset() {
  const p = PRESETS[state.preset] || PRESETS.studio;
  for (const b of presetsEl.children) b.setAttribute('aria-checked', String(b.dataset.id === state.preset));
  const title = $('#presetTitle');
  if (title.textContent !== p.name) {
    title.textContent = p.name;
    if (!REDUCED_MOTION && windowVisible && !document.body.classList.contains('intro-on')) {
      for (const a of title.getAnimations()) a.cancel();
      title.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  }
  document.documentElement.style.setProperty('--hue', p.hue);
}

/* ───────── Preset files ───────── */
$('#presetSave').addEventListener('click', async () => {
  const saved = await window.auraSystem.exportPreset({ app: 'aura', version: 2, name: PRESETS[state.preset]?.name || 'Свой', v: state.v, eq: state.eq });
  if (saved) flash('Пресет сохранён в файл');
});
$('#presetLoad').addEventListener('click', async () => {
  const data = await window.auraSystem.importPreset();
  if (!data) return;
  if (data.error) return flash('Это не файл пресета Aura', true);
  // Only the sound travels in a file; room settings (noise, echo, gate) stay yours.
  const v = {};
  const eq = {};
  for (const p of PARAMS.filter((q) => !q.global)) {
    const n = Number((p.eq ? data.eq : data.v)?.[p.id]);
    const value = Number.isFinite(n) ? clamp(Math.round(n), p.min ?? 0, p.max ?? 100) : p.eq ? 0 : PRESETS.studio.v[p.id];
    if (p.eq) { if (value) eq[p.id] = value; } else v[p.id] = value;
  }
  state.custom = { v, eq };
  selectPreset('custom');
  flash('Пресет загружен в «Свой»');
});

/* ───────── Sliders ───────── */
const fill = (input) => {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--p', `${p}%`);
  if (input._eq) queueEq(); // the curve follows its handles
};
const slidersEl = $('#sliders');
const sliderInputs = {};
const bank = (p) => (p.eq ? state.eq : p.global ? state.g : state.v);
const show = (p, v) => (p.format ? p.format(Number(v)) : String(v));
// One instrument instead of a column of sliders: every setting is a band of an equalizer, and a
// glowing curve runs through the handles, so a character reads as a shape. Two banks: what the
// voice is like (presets move these) and what the room needs (they stay yours).
const EQ_IDLE = ['Эквалайзер голоса', 'Пресет ставит полосы, вы подправляете. Наведите на любую — здесь появится, что она меняет'];
slidersEl.innerHTML = `<div class="eq-head"><b id="eqName"></b><em id="eqValue"></em><small id="eqHint"></small></div>
<div class="eq-tools"><div class="segmented eq-tabs" id="eqTabs" role="radiogroup" aria-label="Что показывает эквалайзер"><button type="button" role="radio" data-bank="freq">Частоты</button><button type="button" role="radio" data-bank="tone">Обработка</button></div><button type="button" class="link" id="eqReset">Сбросить частоты</button></div>
<div class="eq-body"><svg class="eq-curve" aria-hidden="true"><defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="eq-stop-a"/><stop offset="1" class="eq-stop-b"/></linearGradient></defs></svg>
<div class="eq-bank" data-bank="tone" data-title="Обработка"></div><div class="eq-bank" data-bank="freq" data-title="Частоты, дБ"></div><div class="eq-bank room" data-title="Комната и микрофон"></div></div>`;
const eqSvg = slidersEl.querySelector('svg');
const eqBody = slidersEl.querySelector('.eq-body');
const eqBanks = [...slidersEl.querySelectorAll('.eq-bank')].map((el) => {
  const make = (cls) => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', cls);
    eqSvg.append(path);
    return path;
  };
  return { el, inputs: [], area: make('eq-area'), line: make('eq-line') };
});
const eqShow = (p, input) => {
  $('#eqName').textContent = p ? p.name : EQ_IDLE[0];
  $('#eqHint').textContent = p ? p.hint : EQ_IDLE[1];
  $('#eqValue').textContent = p ? show(p, Math.round(input.value)) : '';
};
eqShow(null);
let eqQueued = 0;
function drawEq() {
  eqQueued = 0;
  const box = eqBody.getBoundingClientRect();
  if (!box.width) return; // the page is hidden; the resize observer redraws when it comes back
  eqSvg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  for (const b of eqBanks) {
    if (!b.el.offsetParent) { // the bank is switched away
      b.line.setAttribute('d', '');
      b.area.setAttribute('d', '');
      continue;
    }
    let floor = 0;
    const pts = b.inputs.map((input) => {
      const r = input.parentElement.getBoundingClientRect(); // the upright fader box; the input inside is rotated
      const f = (input.value - input.min) / (input.max - input.min);
      floor = r.bottom - box.top;
      return [r.left + r.width / 2 - box.left, floor - 8 - f * (r.height - 16)]; // 8 = the handle's radius
    });
    const edge = b.el.getBoundingClientRect();
    const x0 = edge.left - box.left;
    const x1 = edge.right - box.left;
    const all = [[x0, pts[0][1]], ...pts, [x1, pts[pts.length - 1][1]]];
    let d = `M${all[0][0]},${all[0][1]}`;
    for (let i = 1; i < all.length; i++) {
      const [ax, ay] = all[i - 1];
      const [bx, by] = all[i];
      const mx = (ax + bx) / 2;
      d += `C${mx},${ay} ${mx},${by} ${bx},${by}`; // level tangents at every handle: the classic EQ curve
    }
    b.line.setAttribute('d', d);
    b.area.setAttribute('d', `${d}L${x1},${floor}L${x0},${floor}Z`);
  }
}
const queueEq = () => {
  if (!eqQueued) eqQueued = requestAnimationFrame(drawEq);
};
new ResizeObserver(queueEq).observe(eqBody);
eqBody.addEventListener('pointerleave', () => {
  if (!eqBody.contains(document.activeElement)) eqShow(null);
});
for (const p of PARAMS) {
  const label = document.createElement('label');
  label.className = 'band';
  label.title = p.hint;
  label.innerHTML = `<em></em><span class="fader"><input type="range" min="${p.min ?? 0}" max="${p.max ?? 100}" step="1" aria-orientation="vertical"></span><b>${p.short}</b>`;
  const input = label.querySelector('input');
  const value = label.querySelector('em');
  input._eq = true;
  input.setAttribute('aria-label', `${p.name}. ${p.hint}`);
  const eqBank = eqBanks[p.eq ? 1 : p.global ? 2 : 0];
  eqBank.inputs.push(input);
  label.addEventListener('pointerenter', () => eqShow(p, input));
  input.addEventListener('focus', () => eqShow(p, input));
  input.addEventListener('blur', () => eqShow(null));
  input.addEventListener('input', () => eqShow(p, input));
  input.addEventListener('input', () => {
    bank(p)[p.id] = Number(input.value);
    value.textContent = show(p, input.value);
    fill(input);
    if (!p.global) {
      // Hand-tuning a sound turns it into the user's own preset, so it is never lost.
      state.custom = { v: { ...state.v }, eq: { ...state.eq } };
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
  eqBank.el.append(label);
}
// «Характер» and «Частоты» share the left side of the card; the room bank stays.
function showEqTab(tab) {
  state.eqTab = tab === 'freq' ? 'freq' : 'tone';
  for (const b of $('#eqTabs').children) b.setAttribute('aria-checked', String(b.dataset.bank === state.eqTab));
  for (const b of eqBanks) if (b.el.dataset.bank) b.el.hidden = b.el.dataset.bank !== state.eqTab;
  $('#eqReset').hidden = state.eqTab !== 'freq' || !FREQS.some((p) => state.eq[p.id]);
  queueEq();
}
$('#eqTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  showEqTab(b.dataset.bank);
  save();
});
$('#eqReset').addEventListener('click', () => {
  state.eq = {};
  state.custom = { v: { ...state.v }, eq: {} };
  state.preset = 'custom';
  renderPreset();
  reportToTray();
  renderSliders(true);
  showEqTab('freq');
  applyAll();
  save();
});
slidersEl.addEventListener('input', () => showEqTab(state.eqTab)); // keeps «Сбросить» in step
// With `animate`, thumbs and fills glide to the new values together (a preset moved them, and the
// eye should see which ones and how far). The numbers and the sound switch at once.
let sliderTween = 0;
function renderSliders(animate = false) {
  cancelAnimationFrame(sliderTween);
  const rows = PARAMS.map((p) => {
    const { input, value } = sliderInputs[p.id];
    const to = bank(p)[p.id] ?? 0;
    value.textContent = show(p, to);
    return { input, from: Number(input.value), to };
  });
  const settle = () => {
    for (const r of rows) {
      r.input.step = '1';
      r.input.value = r.to;
      fill(r.input);
    }
  };
  if (!animate || REDUCED_MOTION || !windowVisible || !slidersEl.offsetParent) return settle();
  for (const r of rows) r.input.step = 'any'; // fractional positions, for the length of the glide only
  const t0 = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - t0) / 280);
    const e = 1 - Math.pow(1 - t, 4);
    for (const r of rows) {
      r.input.value = r.from + (r.to - r.from) * e;
      fill(r.input);
    }
    if (t < 1) sliderTween = requestAnimationFrame(tick);
    else settle();
  };
  sliderTween = requestAnimationFrame(tick);
}
slidersEl.addEventListener('pointerdown', () => renderSliders(), true); // grabbing a thumb mid-glide settles it first

const signed = (db) => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db)} дБ`;
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
  el.title = el.selectedOptions[0]?.textContent || '';
}

async function refreshDevices() {
  devices = fixture ? fixture.devices() : (await navigator.mediaDevices.enumerateDevices()).filter(real);
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

document.addEventListener('change', (e) => {
  if (e.target.tagName === 'SELECT') e.target.title = e.target.selectedOptions[0]?.textContent || '';
});

/* ───────── Compare (hold) ───────── */
const compareBtn = $('#compare');
let held = false;
const holdCompare = (on) => {
  if (on === held) return; // releases that were never presses change nothing
  held = on;
  compareBtn.classList.toggle('held', on);
  if (on) {
    // The processing lives in the microphone: switch it off there for as long as the button is held.
    if (sys.installed && !engine.sampleMode) holdingOriginal = true;
    else engine.setBypass(true);
  } else {
    // Undo both ways of bypassing, whichever one the press used: the mode may have changed meanwhile.
    holdingOriginal = false;
    if (sys.installed) syncBypass();
    else engine.setBypass(false);
  }
  pushSystem();
};
compareBtn.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || tuning) return; // auto-setup is measuring the raw microphone right now
  compareBtn.setPointerCapture(e.pointerId);
  holdCompare(true);
});
for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) compareBtn.addEventListener(ev, () => holdCompare(false));
compareBtn.addEventListener('keydown', (e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && !tuning && holdCompare(true));
compareBtn.addEventListener('keyup', () => holdCompare(false));
compareBtn.addEventListener('blur', () => holdCompare(false));
addEventListener('blur', () => holdCompare(false)); // Alt+Tab while holding

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
const padSources = new Set(); // everything currently playing to the user's ears

// The key shown on a pad: its own, or Ctrl+Alt+digit for the first nine.
const padKey = (pad, index) => pad.key || (index < 9 ? `Ctrl+Alt+${index + 1}` : '');
// On the pad itself only the final key fits; the full combination is in the tooltip and the menu.
const KEY_NAMES = { PageDown: 'PgDn', PageUp: 'PgUp', Insert: 'Ins', Space: '␣', Left: '←', Right: '→', Up: '↑', Down: '↓' };
const shortKey = (accel) => {
  const key = accel.split('+').pop();
  return KEY_NAMES[key] || key.replace(/^num/, 'Num');
};

// A stable colour per sound, so the board reads at a glance and a pad keeps its colour when it moves.
const hueOf = (text) => {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
};
let dragFrom = -1;
let padsDrawn = false; // no entrance on the very first paint
function renderPads() {
  const before = new Map([...padsEl.children].map((el) => [el._pad, el.getBoundingClientRect()]));
  // Sounds with the same name get a number on screen (the stored name is left alone), so two
  // "Bruh" pads can be told apart: the second one carries №2, the third №3.
  const seen = new Map();
  const copies = state.pads.map((pad) => {
    const key = pad.name.trim().toLowerCase();
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    return n;
  });
  padsEl.replaceChildren(
    ...state.pads.map((pad, index) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pad';
      b._pad = pad;
      b.style.setProperty('--h', hueOf(pad.name));
      const accel = padKey(pad, index);
      if (accel) {
        const key = document.createElement('kbd');
        key.textContent = shortKey(accel);
        key.classList.toggle('failed', hotkeyFailed.has(accel));
        b.append(key);
      }
      const label = document.createElement('span');
      label.className = 'pad-name';
      label.dir = 'auto';
      label.textContent = pad.name;
      if (copies[index] > 1) {
        // Its own corner badge: a suffix on the name would be the first thing truncation cuts off.
        const copy = document.createElement('i');
        copy.className = 'pad-copy';
        copy.textContent = `№${copies[index]}`;
        b.append(copy);
      }
      b.append(label);
      b.title = `${pad.name}${copies[index] > 1 ? ` (№${copies[index]})` : ''}${accel ? ' · ' + accel : ''}${hotkeyFailed.has(accel) ? ' (занята другой программой)' : ''} — правый клик: имя, клавиша, удаление; перетащите, чтобы переставить`;
      b.addEventListener('click', () => playPad(pad));
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openPadMenu(pad, e.clientX, e.clientY);
      });
      // Drag to reorder.
      b.draggable = true;
      b.addEventListener('dragstart', (e) => {
        dragFrom = index;
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => b.classList.add('dragging')); // after the drag image is taken, so the ghost is not faded
      });
      b.addEventListener('dragend', () => {
        dragFrom = -1;
        b.classList.remove('dragging');
      });
      b.addEventListener('dragover', (e) => {
        if (dragFrom < 0 || dragFrom === index) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        b.classList.add(dragFrom < index ? 'drop-after' : 'drop-before'); // which side it will land on
      });
      b.addEventListener('dragleave', () => b.classList.remove('drop-before', 'drop-after'));
      b.addEventListener('drop', (e) => {
        e.preventDefault();
        if (dragFrom < 0 || dragFrom === index) return;
        const [moved] = state.pads.splice(dragFrom, 1);
        state.pads.splice(index, 0, moved);
        dragFrom = -1; // the dragged element is about to be replaced and may never get its dragend
        padsChanged();
      });
      return b;
    })
  );
  // Show the change as movement: pads slide from where they were, a new one fades in.
  if (padsDrawn && !REDUCED_MOTION && windowVisible && padsEl.offsetParent) {
    for (const el of padsEl.children) {
      const was = before.get(el._pad);
      if (!was) {
        el.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        continue;
      }
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      const dy = was.top - now.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    }
  }
  padsDrawn = true;
  $('#padsEmpty').hidden = state.pads.length > 0;
  // Warm the first pads up in the background, so even their first press is instant.
  for (const pad of state.pads.slice(0, 12)) padSamples(pad).catch(() => {});
}
// A steady "move" cursor across the gaps between pads; a drop there simply does nothing.
padsEl.addEventListener('dragover', (e) => {
  if (dragFrom < 0) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
});
function padsChanged() {
  save();
  renderPads();
  renderCatalog();
  syncHotkeys();
}

/* A small menu for one pad: rename, give it a key, remove it. */
let padMenu = null;
function closePadMenu() {
  padMenu?.remove();
  padMenu = null;
  stopCapture();
}
function openPadMenu(pad, x, y) {
  closePadMenu();
  const menu = (padMenu = document.createElement('div'));
  menu.className = 'menu';

  const name = document.createElement('input');
  name.type = 'text';
  name.value = pad.name;
  name.maxLength = 40;
  name.setAttribute('aria-label', 'Название звука');
  const rename = () => {
    const value = name.value.trim();
    if (value && value !== pad.name) {
      pad.name = value;
      padsChanged();
    }
  };
  name.addEventListener('change', rename);
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      rename();
      closePadMenu();
    }
  });

  const key = document.createElement('button');
  key.type = 'button';
  const keyLabel = () => (key.textContent = `Клавиша: ${pad.key || padKey(pad, state.pads.indexOf(pad)) || 'нет'}`);
  keyLabel();
  key.addEventListener('blur', stopCapture); // clicking elsewhere must not leave the keyboard captured
  key.addEventListener('click', () => {
    key.textContent = 'Нажмите сочетание… (Esc — отмена, Backspace — убрать)';
    captureHotkey((accel) => {
      if (accel !== null) {
        if (accel) delete state.pads.find((p) => p !== pad && p.key === accel)?.key; // a key belongs to one pad
        if (accel) pad.key = accel;
        else delete pad.key;
        padsChanged();
      }
      keyLabel();
    });
  });

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = 'Убрать звук';
  remove.addEventListener('click', () => {
    state.pads = state.pads.filter((p) => p !== pad);
    padCache.delete(pad.id);
    window.auraSystem.removeSound(pad.id);
    closePadMenu();
    padsChanged();
  });

  menu.append(name, key, remove);
  document.body.append(menu);
  // offsetWidth, not getBoundingClientRect: the entrance animation is holding the menu at 94 % right now.
  const left = Math.max(12, Math.min(x, innerWidth - menu.offsetWidth - 12));
  const top = Math.max(12, Math.min(y, innerHeight - menu.offsetHeight - 12));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${x - left}px ${y - top}px`; // grows out of the cursor even when clamped
  name.select();
}
addEventListener('pointerdown', (e) => {
  if (!padMenu || padMenu.contains(e.target)) return;
  padMenu.querySelector('input')?.dispatchEvent(new Event('change')); // clicking away keeps a typed name
  closePadMenu();
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && padMenu) closePadMenu(); // during key capture the capturing handler takes Esc first
});
addEventListener('blur', () => closePadMenu());

function stopLocalPad() {
  for (const source of padSources) {
    try {
      source.stop();
    } catch {}
  }
  padSources.clear();
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
async function playLocal(mono, onEnded, exclusive = false) {
  if (exclusive) stopLocalPad(); // previews replace each other; pads pile up, like on a real soundboard
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
    padSources.delete(source);
    onEnded?.();
  };
  source.start();
  padSources.add(source);
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
  if (!sys.installed) return flash('Звук слышите только вы. Чтобы он шёл в микрофон, встройте модуль в «Настройках».', 'warn');
  if (!(await window.auraSystem.writeClip(mono))) return flash('Не удалось передать звук модулю.', true);
  state.playId++;
  save();
  pushSystem();
}

$('#padAdd').addEventListener('click', async () => {
  const added = await window.auraSystem.addSounds();
  if (!added?.length) return;
  state.pads.push(...added);
  padsChanged();
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

/* ───────── Ready voices ─────────
 * One tap changes who you sound like. These sit on top of the character and the sliders, and
 * live in the module, so every program hears them. Values are the module's own units.
 * `fxnatural` = move the pitch but keep the timbre: a different person, not a cartoon. */
const FX_ZERO = { fxpitch: 0, fxnatural: 0, fxformant: 0, fxring: 0, fxringmix: 0, fxecho: 0, fxechofb: 0, fxechomix: 0, fxphone: 0, fxdrive: 0, fxtrem: 0, fxtremdepth: 0, fxlp: 0, fxspace: 0 };
// Line symbols in the manner of SF Symbols, drawn on a 24-unit grid; each voice shows one in white
// on a rounded square of a system colour, the way iOS Settings marks its rows.
const SYMBOLS = {
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  person: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  child: '<circle cx="12" cy="9.5" r="3"/><path d="M7 20a5 5 0 0 1 10 0"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  balloon: '<path d="M12 3a6 6 0 0 1 6 6c0 4-4 7-6 7s-6-3-6-7a6 6 0 0 1 6-6z"/><path d="M12 16v5"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="6.8" cy="18" r="2.3"/><circle cx="16.8" cy="16" r="2.3"/>',
  mountain: '<path d="M3 19l6-10 4 6 2-3 6 7z"/>',
  flame: '<path d="M12 3c1 4 5 5.5 5 10.5a5 5 0 0 1-10 0c0-2 .8-3.2 2-4.2 0 2 .8 3 1.8 3 .2-3-.8-5.3 1.2-9.3z"/>',
  cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3.5V7M14 3.5V7M10 17v3.5M14 17v3.5M3.5 10H7M3.5 14H7M17 10h3.5M17 14h3.5"/>',
  star: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  phone: '<path d="M6 3.5h3l1.8 4.8-2.3 1.5a11 11 0 0 0 5.7 5.7l1.5-2.3 4.8 1.8v3a2 2 0 0 1-2 2A15.5 15.5 0 0 1 4 5.5a2 2 0 0 1 2-2z"/>',
  radio: '<rect x="8" y="7.5" width="8" height="13" rx="2"/><path d="M10.5 7.5V3.5M10.5 11.5h3"/>',
  megaphone: '<path d="M4 10v4l3.5.6V9.4zM7.5 9.4L19 5.5v13L7.5 14.6M9.5 15.2l1 4h2.2"/>',
  cave: '<path d="M3 20v-8.5a9 9 0 0 1 18 0V20"/><path d="M9 20v-5a3 3 0 0 1 6 0v5"/>',
  columns: '<path d="M3 9l9-5 9 5zM5 9v9M9.7 9v9M14.3 9v9M19 9v9M3 20h18"/>',
  waves: '<path d="M3 8c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 13c2-2 4-2 6 0s4 2 6 0 4-2 6 0M3 18c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/>',
  pulse: '<path d="M3 12h2.5l2-6 3 12 3-9 2 6 1.5-3H21"/>',
  sliders: '<path d="M4 7h9M19 7h1M4 17h1M11 17h9"/><circle cx="16" cy="7" r="2.6"/><circle cx="8" cy="17" r="2.6"/>',
};
const VOICES = {
  none: { name: 'Обычный голос', hint: 'Без эффекта', icon: 'mic', color: '#8e8e93', p: {} },
  girl: { name: 'Девушка', hint: 'Выше, тембр почти свой', icon: 'person', color: '#ff375f', p: { fxpitch: 5, fxnatural: 1, fxformant: 1.5 } },
  guy: { name: 'Парень', hint: 'Ниже, тембр почти свой', icon: 'person', color: '#0a84ff', p: { fxpitch: -4, fxnatural: 1, fxformant: -1.5 } },
  kid: { name: 'Ребёнок', hint: 'Высокий и маленький', icon: 'child', color: '#ff9f0a', p: { fxpitch: 8, fxnatural: 1, fxformant: 3 } },
  higher: { name: 'Выше', hint: 'Тот же человек, тоньше', icon: 'up', color: '#30b0c7', p: { fxpitch: 3, fxnatural: 1 } },
  lower: { name: 'Ниже', hint: 'Тот же человек, глубже', icon: 'down', color: '#5e5ce6', p: { fxpitch: -3, fxnatural: 1 } },
  helium: { name: 'Гелий', hint: 'Как после шарика', icon: 'balloon', color: '#ff453a', p: { fxpitch: 7 } },
  chipmunk: { name: 'Бурундук', hint: 'Совсем тоненький', icon: 'note', color: '#a2845e', p: { fxpitch: 11 } },
  giant: { name: 'Великан', hint: 'Низкий и большой', icon: 'mountain', color: '#34c759', p: { fxpitch: -6 } },
  demon: { name: 'Демон', hint: 'Низко, с хрипом и залом', icon: 'flame', color: '#d70015', p: { fxpitch: -8, fxdrive: 30, fxspace: 50 } },
  robot: { name: 'Робот', hint: 'Металлический, ровный', icon: 'cpu', color: '#64748b', p: { fxring: 55, fxringmix: 85 } },
  alien: { name: 'Пришелец', hint: 'Звенящий, не отсюда', icon: 'star', color: '#30d158', p: { fxring: 190, fxringmix: 60, fxpitch: 3 } },
  phone: { name: 'Телефон', hint: 'Узкая полоса, как в трубке', icon: 'phone', color: '#34c759', p: { fxphone: 1 } },
  radio: { name: 'Рация', hint: 'Трубка с перегрузом', icon: 'radio', color: '#ff9500', p: { fxphone: 1, fxdrive: 55 } },
  megaphone: { name: 'Мегафон', hint: 'Громкоговоритель на площади', icon: 'megaphone', color: '#ff6b00', p: { fxphone: 1, fxdrive: 80, fxecho: 90, fxechofb: 20, fxechomix: 25 } },
  cave: { name: 'Пещера', hint: 'Долгое эхо', icon: 'cave', color: '#8e5bd9', p: { fxecho: 260, fxechofb: 50, fxechomix: 45, fxspace: 80 } },
  hall: { name: 'Собор', hint: 'Большой гулкий зал', icon: 'columns', color: '#af52de', p: { fxspace: 100 } },
  underwater: { name: 'Под водой', hint: 'Глухо и с бульканьем', icon: 'waves', color: '#32ade6', p: { fxlp: 600, fxtrem: 5, fxtremdepth: 50 } },
  shaky: { name: 'Дрожащий', hint: 'Голос трясётся', icon: 'pulse', color: '#00c7be', p: { fxtrem: 8, fxtremdepth: 70 } },
  custom: { name: 'Свой', hint: 'Соберите из ручек ниже', icon: 'sliders', color: '#ffcc00', p: null },
};
// The knobs of the user's own voice, in plain words; customFx() turns them into module values.
const CUSTOM_KNOBS = [
  { id: 'pitch', name: 'Тон', hint: 'Ниже или выше, в полутонах', min: -12, max: 12, signed: true },
  { id: 'formant', name: 'Тембр', hint: '«Размер» голоса: меньше или больше', min: -5, max: 5, signed: true },
  { id: 'robot', name: 'Робот', hint: 'Металлический призвук' },
  { id: 'drive', name: 'Искажение', hint: 'Хрип и перегруз' },
  { id: 'echo', name: 'Эхо', hint: 'Повторы после слов' },
  { id: 'space', name: 'Зал', hint: 'Гулкое помещение' },
  { id: 'trem', name: 'Дрожь', hint: 'Голос трясётся' },
  { id: 'phone', name: 'Трубка', hint: 'Узкая полоса, как в телефоне', max: 1, toggle: true },
];
function customFx() {
  const c = state.fxCustom;
  return {
    fxpitch: c.pitch,
    fxformant: c.formant,
    // Small shifts sound like a person when the timbre is kept; big ones are meant to be cartoonish.
    fxnatural: c.formant !== 0 || (c.pitch !== 0 && Math.abs(c.pitch) <= 6) ? 1 : 0,
    fxring: c.robot ? 55 : 0,
    fxringmix: c.robot,
    fxdrive: c.drive,
    fxecho: c.echo ? 220 : 0,
    fxechofb: c.echo ? 45 : 0,
    fxechomix: Math.round(c.echo * 0.6),
    fxspace: c.space,
    fxtrem: c.trem ? 7 : 0,
    fxtremdepth: c.trem,
    fxphone: c.phone ? 1 : 0,
  };
}
function fxValues() {
  return { ...FX_ZERO, ...(state.fx === 'custom' ? customFx() : (VOICES[state.fx] || VOICES.none).p) };
}
function selectVoice(id) {
  state.fx = VOICES[id] ? id : 'none';
  save();
  applyAll();
  renderVoices();
  liveStatus();
  reportToTray();
}

const voicesEl = $('#voices');
const voiceTiles = {};
for (const [id, voice] of Object.entries(VOICES)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'voice';
  b.setAttribute('role', 'radio');
  const icon = document.createElement('span');
  icon.className = 'voice-icon';
  icon.style.setProperty('--c', voice.color);
  icon.innerHTML = `<svg viewBox="0 0 24 24">${SYMBOLS[voice.icon]}</svg>`; // static markup from the table above
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'voice-text';
  const name = document.createElement('b');
  name.textContent = voice.name;
  const hint = document.createElement('small');
  text.append(name, hint);
  const key = document.createElement('kbd');
  b.append(icon, text, key);
  b.addEventListener('click', () => selectVoice(id));
  // Right-click: give this voice a key of its own.
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    hint.textContent = 'Нажмите сочетание… Esc — отмена';
    b.focus();
    captureHotkey((accel) => {
      if (accel !== null) {
        for (const other of Object.keys(state.fxKeys)) if (state.fxKeys[other] === accel) delete state.fxKeys[other]; // one key, one voice
        if (accel) state.fxKeys[id] = accel;
        else delete state.fxKeys[id];
        save();
        syncHotkeys();
      }
      renderVoices();
    });
  });
  b.addEventListener('blur', stopCapture);
  voiceTiles[id] = { b, hint, key };
  voicesEl.append(b);
}

// The editor for "Свой": a few knobs in plain words.
const knobsEl = $('#fxKnobs');
for (const knob of CUSTOM_KNOBS) {
  const label = document.createElement('label');
  label.className = 'slider';
  label.innerHTML = `<span><b>${knob.name}</b><em></em></span><input type="range" min="${knob.min ?? 0}" max="${knob.max ?? 100}" step="1"><small>${knob.hint}</small>`;
  const input = label.querySelector('input');
  const value = label.querySelector('em');
  const showKnob = () => {
    const v = Number(input.value);
    value.textContent = knob.toggle ? (v ? 'да' : 'нет') : knob.signed && v > 0 ? `+${v}` : String(v).replace('-', '−');
    fill(input);
  };
  input.value = state.fxCustom[knob.id] ?? 0;
  showKnob();
  input.addEventListener('input', () => {
    state.fxCustom[knob.id] = Number(input.value);
    showKnob();
    applyAll();
    save();
    liveStatus();
  });
  knobsEl.append(label);
}

function renderVoices() {
  if (!VOICES[state.fx]) state.fx = 'none';
  for (const [id, tile] of Object.entries(voiceTiles)) {
    const accel = state.fxKeys[id] || '';
    tile.b.setAttribute('aria-checked', String(id === state.fx));
    tile.hint.textContent = VOICES[id].hint;
    tile.key.textContent = accel ? shortKey(accel) : '';
    tile.key.hidden = !accel;
    tile.key.classList.toggle('failed', hotkeyFailed.has(accel));
    tile.b.title = `${VOICES[id].name}${accel ? ' · ' + accel + (hotkeyFailed.has(accel) ? ' (занята другой программой)' : '') : ''} — правый клик: назначить клавишу`;
  }
  $('#fxCustom').hidden = state.fx !== 'custom';
  const note = $('#fxNote');
  // The effects run inside the microphone module, on the processed voice.
  const problem = !sys.installed ? 'Нужен модуль в микрофоне: встройте его на вкладке «Настройки».' : !engine.running ? 'Включите сферу — эффекты накладываются на обработанный голос.' : '';
  note.textContent = problem || 'Слышат все программы. Правый клик по голосу — назначить клавишу.';
  note.classList.toggle('warn', !!problem);
  // The current voice is always visible under the big title, whatever page is open.
  const chip = $('#fxChip');
  chip.hidden = state.fx === 'none';
  chip.textContent = `${VOICES[state.fx].name}  ✕`;
}
$('#fxChip').addEventListener('click', () => selectVoice('none'));

/* ───────── Hotkeys ─────────
 * Global shortcuts live in the main process; this side decides what they are. */
let hotkeyFailed = new Set(); // combinations Windows refused (another program owns them)
let capturing = null;

function accelFromEvent(e) {
  const c = e.code;
  let key = null;
  if (/^Key[A-Z]$/.test(c)) key = c[3];
  else if (/^Digit\d$/.test(c)) key = c[5];
  else if (/^F\d{1,2}$/.test(c)) key = c;
  else if (/^Numpad\d$/.test(c)) key = 'num' + c[6];
  else if (['Space', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(c)) key = c;
  else if (/^Arrow/.test(c)) key = c.slice(5);
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  if (!mods.length && !/^F\d/.test(key)) return null; // a bare letter would hijack typing everywhere
  return [...mods, key].join('+');
}
// done(accel): a combination, '' to clear, or null when cancelled.
function captureHotkey(done) {
  stopCapture();
  capturing = done;
}
function stopCapture() {
  const done = capturing;
  capturing = null;
  done?.(null);
}
addEventListener(
  'keydown',
  (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    const done = capturing;
    if (e.key === 'Escape') {
      capturing = null;
      return done(null);
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      capturing = null;
      return done('');
    }
    const accel = accelFromEvent(e);
    if (!accel) return; // still holding modifiers
    capturing = null;
    done(accel);
  },
  true
);

async function syncHotkeys() {
  if (!window.auraSystem?.setHotkeys || TEST) return;
  const failed = await window.auraSystem.setHotkeys({ power: state.hotkeys.power, mute: state.hotkeys.mute, pads: state.pads.map((p) => p.key || null), voices: Object.entries(state.fxKeys) });
  const next = new Set(fixture ? fixture.failedHotkeys : failed || []);
  const changed = next.size !== hotkeyFailed.size || [...next].some((accel) => !hotkeyFailed.has(accel));
  hotkeyFailed = next;
  renderHotkeys();
  renderVoices();
  if (changed) renderPads(); // not a second rebuild of the whole grid for nothing
}
function renderHotkeys() {
  for (const id of ['power', 'mute']) {
    const accel = state.hotkeys[id];
    const button = $(`#key-${id}`);
    const failed = hotkeyFailed.has(accel);
    button.textContent = accel || 'Не задана';
    button.title = accel || '';
    button.classList.toggle('failed', failed);
    $(`#note-${id}`).textContent = failed ? 'Занята другой программой — выберите другую' : '';
  }
  $('#muteKey').textContent = state.hotkeys.mute ? ` · ${state.hotkeys.mute}` : '';
}
for (const id of ['power', 'mute']) {
  $(`#key-${id}`).addEventListener('blur', stopCapture); // clicking elsewhere must not leave the keyboard captured
  $(`#key-${id}`).addEventListener('click', (e) => {
    e.currentTarget.textContent = 'Нажмите сочетание… (Esc — отмена, Backspace — убрать)';
    captureHotkey((accel) => {
      if (accel !== null) {
        state.hotkeys[id] = accel;
        save();
        syncHotkeys();
      } else {
        renderHotkeys();
      }
    });
  });
}

/* ───────── Microphone for the module ───────── */
async function loadCaptureDevices() {
  if (!window.auraSystem?.captureDevices || TEST) return;
  captureDevices = fixture ? fixture.captureDevices : (await window.auraSystem.captureDevices()) || [];
  const select = $('#sysDevice');
  select.replaceChildren(...captureDevices.map((d) => new Option(d.name, d.guid)));
  const current = captureDevices.find((d) => d.current);
  if (current) select.value = current.guid;
  select.title = select.selectedOptions[0]?.textContent || '';
  renderSystem();
  renderMic();
  applyAll(); // the profile follows the microphone's name
}
$('#sysDevice').addEventListener('change', () => renderSystem());

/* ───────── First steps ───────── */
function renderGuide() {
  const guide = $('#guide');
  guide.hidden = state.onboarded || TEST;
  if (guide.hidden) return;
  $('#guide1').classList.toggle('done', sys.installed);
  $('#guide2').classList.toggle('done', state.tuned);
  $('#guide3').classList.toggle('done', state.preset !== 'studio');
}
$('#guideClose').addEventListener('click', (e) => {
  const guide = $('#guide');
  const close = () => {
    guide.style.overflow = '';
    state.onboarded = true; // only now, so the periodic re-render cannot hide the card mid-collapse
    save();
    renderGuide();
  };
  if (REDUCED_MOTION) return close();
  e.currentTarget.disabled = true;
  guide.style.overflow = 'hidden';
  guide
    .animate(
      [
        { height: `${guide.offsetHeight}px`, opacity: 1, marginBottom: '0px' },
        { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, marginBottom: '-16px' },
      ],
      { duration: 260, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }
    )
    .finished.then(close, close);
});
$('#guide1').addEventListener('click', () => showTab('setup'));

/* ───────── Catalogue (UwUpad) ─────────
 * Browse and search the site's sounds without leaving the window: listen first (only you
 * hear the preview), then one click puts the sound on a pad. */
const catalog = { feed: 'popular', query: '', items: [], total: 0, loading: false, started: false, previewing: null, request: 0 };
const catalogPlays = new Map(); // item id → its play button
function markPreview() {
  for (const [id, button] of catalogPlays) button.textContent = catalog.previewing === id ? '■' : '▶';
}
const catalogList = $('#catalogList');
const compact = new Intl.NumberFormat('ru', { notation: 'compact', maximumFractionDigits: 1 });
const formatCount = (n) => (Number.isFinite(n) && n >= 0 ? compact.format(n) : '0'); // 1340327 → «1,3 млн»
const formatDuration = (s) => (!(s >= 1) ? '<1 с' : s < 60 ? `${Math.round(s)} с` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`);
const catalogNote = (text) => ($('#catalogNote').textContent = text);

async function loadCatalog(reset) {
  if (catalog.loading && !reset) return; // "show more" waits its turn; a new search or feed supersedes
  const request = ++catalog.request;
  catalog.loading = true;
  if (reset) catalog.items = [];
  catalogNote('Загружаю…');
  const res = await (fixture ? Promise.resolve(fixture.catalog(catalog)) : window.auraSystem.catalog({ feed: catalog.feed, query: catalog.query, offset: catalog.items.length })).catch((err) => {
    console.error('catalog failed:', err?.message);
    return null;
  });
  if (request !== catalog.request) return; // a newer request went out while this one was on its way
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
  // The rebuild replaces the button that was just pressed; give the keyboard focus back to its successor.
  const focusAt = catalogList.contains(document.activeElement) ? [...catalogList.querySelectorAll('button')].indexOf(document.activeElement) : -1;
  catalogPlays.clear();
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
      catalogPlays.set(item.id, play);
      const title = document.createElement('span');
      title.className = 'catalog-title';
      title.textContent = item.title.trim() || 'Без названия';
      title.title = title.textContent;
      title.dir = 'auto';
      const meta = document.createElement('span');
      meta.className = 'catalog-meta';
      meta.textContent = [item.explicit ? '18+' : '', item.loud ? 'громкий' : '', formatDuration(item.duration), `♥ ${formatCount(item.likes)}`].filter(Boolean).join(' · ');
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
        padsChanged();
      });
      row.append(play, title, meta, add);
      return row;
    })
  );
  if (focusAt >= 0) catalogList.querySelectorAll('button')[focusAt]?.focus({ preventScroll: true });
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
    return markPreview();
  }
  catalog.previewing = item.id;
  markPreview();
  const done = () => {
    if (catalog.previewing === item.id) {
      catalog.previewing = null;
      markPreview();
    }
  };
  try {
    const bytes = await window.auraSystem.catalogSound(item);
    if (!bytes) throw new Error('no data');
    const mono = await decodeSound(bytes);
    if (catalog.previewing !== item.id) return; // the user moved on while it was downloading
    await playLocal(mono, done, true);
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
    for (const other of $('#catalogFeeds').children) other.setAttribute('aria-checked', String(other === b)); // answer now, not when the network does
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
  $('#pageTitle').textContent = tabButtons.find((b) => b.dataset.tab === name).textContent.trim(); // the page's large title
  for (const page of document.querySelectorAll('.page')) page.hidden = page.dataset.page !== name;
  try {
    localStorage.setItem('aura.tab', name);
  } catch {}
  if (name === 'setup') loadCaptureDevices();
  if (name === 'effects') renderVoices();
  if (name === 'sounds' && !catalog.started) {
    catalog.started = true; // nothing is fetched until the user actually opens the page
    loadCatalog(true);
  }
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));
for (const group of [$('#tabs'), presetsEl]) {
  group.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const items = [...group.children];
    const next = items[(items.indexOf(document.activeElement) + step + items.length) % items.length];
    next.focus();
    next.click();
  });
}

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

/* ───────── Microphone profile ───────── */
const micSelect = $('#micProfile');
function renderMic() {
  const found = MIC_PROFILES.find((p) => p.match && p.match.test(micName()));
  micSelect.replaceChildren(
    new Option(found ? `Авто — ${found.name}` : 'Авто — микрофон не узнан, без коррекции', 'auto'),
    new Option(state.micMeasured ? 'По замеру вашего голоса' : 'По замеру вашего голоса — нажмите «Автонастройка»', 'measured'),
    new Option('Без коррекции', 'none'),
    ...MIC_PROFILES.map((p) => new Option(p.name, p.id))
  );
  micSelect.options[1].disabled = !state.micMeasured;
  micSelect.value = state.mic;
  if (micSelect.selectedIndex < 0) micSelect.value = state.mic = 'auto';
  const p = micProfile();
  $('#micNote').textContent = p
    ? `Коррекция микрофона: срез ниже ${p.hp} Гц${p.bands.map(([f, g]) => `, ${hzText(f)} ${dbText(g)}`).join('')}. ${state.mic === 'measured' ? 'Построена по вашему голосу.' : 'Это стартовый профиль по известным особенностям микрофона; точный строит «Автонастройка» по вашему голосу.'}`
    : 'Коррекции микрофона нет. «Автонастройка» построит её по вашему голосу.';
}
micSelect.addEventListener('change', () => {
  state.mic = micSelect.value;
  renderMic();
  applyAll();
  save();
});

// Long-term average speech spectrum in third-octave bands, dB (after Byrne et al., 1994, rounded):
// what an average voice looks like through a flat microphone. Only its shape is used.
const THIRDS = [100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500];
const SPEECH = [54, 57.5, 59.5, 60, 60.5, 60.5, 61.5, 62, 59.5, 55.5, 54, 53.5, 52.5, 50.5, 49, 48, 47, 46.5, 45.5, 45, 43.5, 41];
const EQ_REGIONS = [
  { f: 120, q: 0, lo: 100, hi: 160, max: 4 },
  { f: 250, q: 1, lo: 200, hi: 315, max: 5 },
  { f: 500, q: 1.1, lo: 400, hi: 630, max: 5 },
  { f: 1200, q: 0.9, lo: 800, hi: 1600, max: 5 },
  { f: 3200, q: 0.9, lo: 2000, hi: 5000, max: 5 },
  { f: 9000, q: 0, lo: 6300, hi: 12500, max: 5 },
];
// Averages the raw microphone's power spectrum while it is being listened to.
function spectrumMeter() {
  const an = engine.ctx.createAnalyser();
  an.fftSize = 4096;
  an.smoothingTimeConstant = 0;
  engine.n.inGain.connect(an);
  const frame = new Float32Array(an.frequencyBinCount);
  const sum = new Float64Array(frame.length);
  let frames = 0;
  return {
    grab() {
      an.getFloatFrequencyData(frame);
      for (let i = 0; i < frame.length; i++) sum[i] += Math.pow(10, frame[i] / 10);
      frames++;
    },
    done() {
      engine.n.inGain.disconnect(an);
      const hz = engine.ctx.sampleRate / an.fftSize;
      // Power per third-octave band.
      return { frames, bands: THIRDS.map((f) => {
        let p = 0;
        for (let i = Math.ceil((f / 1.122) / hz); i < (f * 1.122) / hz && i < sum.length; i++) p += sum[i];
        return frames ? p / frames : 0;
      }) };
    },
  };
}
// Where the voice, through this microphone, departs from an average voice through a flat one —
// and a gentle correction for it: 60 % of the way, a few dB at most, nothing for trifles.
function measuredEq(speech, noise) {
  if (speech.frames < 20) return null;
  const diff = THIRDS.map((_, k) => {
    const voice = speech.bands[k] - noise.bands[k];
    return voice > noise.bands[k] ? 10 * Math.log10(voice) - SPEECH[k] : NaN; // a band buried in noise says nothing
  });
  const mean = (lo, hi) => {
    const xs = diff.filter((d, k) => THIRDS[k] >= lo && THIRDS[k] <= hi && Number.isFinite(d));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
  };
  const level = mean(200, 4000);
  if (!Number.isFinite(level)) return null;
  const bands = [];
  for (const r of EQ_REGIONS) {
    const off = mean(r.lo, r.hi) - level;
    if (!Number.isFinite(off)) continue;
    const gain = Math.round(clamp(-0.6 * off, -r.max, r.max) * 2) / 2;
    if (Math.abs(gain) >= 1) bands.push([r.f, gain, r.q]);
  }
  return { hp: 80, bands };
}

/* ───────── Auto-setup ─────────
 * Listens to the room, then to the voice, and sets input gain, the gate and noise suppression from what it
 * heard — and builds the microphone's corrective EQ from the spectrum of the voice. */
const tuneBtn = $('#tune');
let tuning = false;
async function listen(seconds, label, tick) {
  const levels = [];
  const end = performance.now() + seconds * 1000;
  while (performance.now() < end) {
    setStatus(`${label} · ${Math.ceil((end - performance.now()) / 1000)}`);
    const m = engine.meters();
    if (m && m.in > -100) levels.push(m.in - state.inGain); // the raw microphone, before our own gain
    if (m && tick) tick(m.in - state.inGain);
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

  const quiet = spectrumMeter();
  const noise = percentile(await listen(3, 'Помолчите', () => quiet.grab()), 0.5);
  const talk = spectrumMeter();
  const speech = percentile(await listen(6, 'Говорите обычным голосом', (db) => db > noise + 12 && talk.grab()), 0.8); // only while the voice is there
  const eq = measuredEq(talk.done(), quiet.done());
  holdingOriginal = false;
  tuning = false;
  tuneBtn.classList.remove('live');

  if (speech < noise + 6) {
    pushSystem();
    flash('Не расслышал голос. Попробуйте ещё раз, ближе к микрофону.', true);
    return;
  }
  // Bring the voice to a healthy working level, put the gate just above the room, and pick
  // noise suppression from how far the voice stands above the noise.
  const gain = clamp(Math.round(-26 - speech), -12, 18);
  const snr = speech - noise;
  // The neural denoiser does the cleaning; the pause threshold only has to sit a little above the
  // room. Set high, it eats the quiet starts and ends of words — that is heard as a torn voice.
  state.g.clean = clamp(Math.round((noise + gain + 8 + 65) / 0.4), 5, 70);
  state.g.ns = snr > 45 ? 25 : snr > 30 ? 40 : 60;
  state.auto = true;
  $('#auto').checked = true;
  renderSliders();
  const gainInput = $('#inGain');
  gainInput.value = gain;
  gainInput.dispatchEvent(new Event('input')); // updates the label, applies and saves
  if (eq) {
    state.micMeasured = eq;
    state.mic = 'measured';
    renderMic();
    applyAll();
  }
  state.tuned = true;
  save();
  renderGuide();
  flash(`Настроено: фон ${Math.round(noise)} дБ, голос ${Math.round(speech)} дБ${eq ? ', эквалайзер микрофона подстроен под ваш голос' : ''}`, false, 7000);
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
const dbLabel = (db) => (db < -70 ? '—' : `${Math.round(db)} дБ`.replace('-', '−'));

// Levels reported by the module, refreshed a few times a second while it is in use.
let moduleLevels = null;
setInterval(async () => {
  if (fixture?.levels) return (moduleLevels = fixture.levels), renderEngine();
  if (!sys.installed || !engine.running || TEST || !windowVisible) return (moduleLevels = null);
  const l = await window.auraSystem.levels();
  moduleLevels = l && Number.isFinite(l.in) ? l : null;
  if (fixture?.levels) moduleLevels = fixture.levels;
  renderEngine();
}, 130);

let lastText = 0;
let lastFrame = 0;
let orbSettled = false;
// Told by the main process. With background throttling off (the audio needs that), Chromium keeps
// reporting the page as visible in the tray, so document.hidden cannot be trusted.
let windowVisible = true;
let rafId = 0;
function setWindowVisible(visible) {
  if (visible === windowVisible) return;
  windowVisible = visible;
  cancelAnimationFrame(rafId);
  if (visible) rafId = requestAnimationFrame(frame);
}
function frame(now) {
  rafId = requestAnimationFrame(frame);
  if (now - lastFrame < 15) return; // one pass per ~16 ms, on 144 and 240 Hz screens too
  const k = clamp((now - lastFrame) / 16.667, 0.25, 3); // 1 at 60 Hz: motion keeps its speed if frames are late
  lastFrame = now;
  const ease = (a) => 1 - Math.pow(1 - a, k);
  const m = engine.meters();
  const target = m ? clamp((m.out + 55) / 45, 0, 1) : 0;
  level += (target - level) * ease(target > level ? 0.35 : 0.1);
  energy += ((m ? 1 : 0) - energy) * ease(0.08);

  const wantHue = PRESETS[state.preset]?.hue ?? 212;
  const hueGap = (((wantHue - hue) % 360) + 540) % 360 - 180;
  hue += hueGap * ease(0.08);

  for (let b = 0; b < bands.length; b++) {
    let x = 0;
    if (m) {
      for (let i = 0; i < 5; i++) x += m.spectrum[2 + b * 5 + i];
      x /= 5 * 255;
    }
    bands[b] += (x - bands[b]) * ease(0.25);
  }
  if (!REDUCED_MOTION) rot += (0.004 + level * 0.012) * k;
  // Switched off and come to rest: the picture cannot change, so paint it one last time and stop.
  const settled = !m && energy < 0.003 && level < 0.003 && Math.abs(hueGap) < 0.2;
  if (!settled || !orbSettled) drawOrb();
  orbSettled = settled;

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
    for (const meter of Object.values(meterEls)) setMeter(meter, 0, '—');
  }
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

/* ───────── Launch animation ───────── */
(function intro() {
  const overlay = $('#intro');
  const SPRITE = ['....##......', '...####....#', '..######..##', '.###########', '##E########.', '##E########.', '.###########', '..######..##', '...####....#', '....##......'];
  const fish = $('#introFish');
  SPRITE.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const cell = document.createElement('i');
      if (row[x] !== '.') {
        cell.className = row[x] === 'E' ? 'eye' : 'body';
        // Drawn nose to tail, with a little scatter so it shimmers rather than wipes.
        cell.style.animationDelay = `${Math.round(x * 26 + Math.abs(y - 4.5) * 14 + Math.random() * 70)}ms`;
      }
      fish.append(cell);
    }
  });

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    removeEventListener('pointerdown', finish, true);
    removeEventListener('keydown', finish, true);
    overlay.classList.add('leaving');
    document.body.classList.remove('intro-on');
    setTimeout(() => overlay.remove(), 600);
  };
  if (TEST) return finish();
  addEventListener('pointerdown', finish, true);
  addEventListener('keydown', finish, true);
  setTimeout(finish, REDUCED_MOTION ? 500 : 1450);
})();

/* ───────── Boot ───────── */
async function boot() {
  if (DATA) {
    // Dev only: swap everything that comes from outside for a fixture, at the same boundaries.
    await new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = 'dev-fixtures.js';
      script.onload = script.onerror = resolve;
      document.head.append(script);
    });
    fixture = window.devFixture || null;
    if (fixture) {
      state.pads = fixture.pads;
      if (fixture.hotkeys) state.hotkeys = fixture.hotkeys;
      if (fixture.sysMessage) sysMessage = fixture.sysMessage;
    }
  }
  $('#mute').disabled = true; // until the module is known to be installed
  renderEngine();
  renderPads();
  let savedTab = 'voice';
  try {
    savedTab = new URLSearchParams(location.search).get('tab') || localStorage.getItem('aura.tab') || 'voice';
  } catch {}
  showTab(savedTab);
  renderHotkeys();
  renderGuide();
  syncHotkeys();
  renderPreset();
  renderSliders();
  showEqTab(state.eqTab);
  renderPower();
  rafId = requestAnimationFrame(frame);

  if (!TEST) {
    // Device names are hidden until the microphone has been opened once.
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
    } catch {}
  }
  await refreshDevices();
  await pollSystem();
  renderMic();
  await loadCaptureDevices(); // the microphone's name picks its profile
  setInterval(pollSystem, 2000);
  window.auraSystem?.onCommand((name, arg) => {
    if (name === 'visible') setWindowVisible(!!arg);
    if (name === 'power') setPower(!engine.running);
    if (name === 'preset') selectPreset(arg);
    if (name === 'voice') selectVoice(arg === state.fx ? 'none' : arg); // the same key again switches it off
    if (name === 'pad' && state.pads[arg]) playPad(state.pads[arg]);
    if (name === 'mute' && sys.installed) {
      $('#mute').checked = state.mute = !state.mute;
      save();
      pushSystem();
      reportToTray();
    }
  });
  if (state.on) await setPower(true);
  if (fixture?.status) setStatus(fixture.status, true);

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

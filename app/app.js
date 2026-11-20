const $ = (s) => document.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TEST = new URLSearchParams(location.search).has('test');
const PROBE = new URLSearchParams(location.search).has('probe');
const DATA = new URLSearchParams(location.search).get('data'); // dev only: worst-case fixtures, see dev-fixtures.js
// Windows 11 draws Mica behind the window: the page leaves its own background off (see «Windows 11» in style.css)
if (new URLSearchParams(location.search).has('mica')) document.documentElement.classList.add('mica');
let fixture = null;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PARAMS = [
  // `short` is the label under the band in the equalizer; the full name shows above it on hover.
  // Processing: everything about the voice that is not its frequency balance.
  { id: 'density', name: 'Плотность', short: 'Плотность', hint: 'Компрессор: тихое громче, громкое тише — ровный «дикторский» голос' },
  { id: 'excite', name: 'Блеск', short: 'Блеск', hint: 'Добавляет гармоники поверх голоса: звучит чётче и «дороже» даже в маленьких колонках' },
  { id: 'multiband', name: 'Вещание', short: 'Вещание', hint: 'Сжимает низ, середину и верх по отдельности: бас не плавает от расстояния до микрофона, верх не режет' },
  { id: 'sat', name: 'Сочность', short: 'Сочность', hint: 'Гармоники от баса: голос кажется гуще даже в телефоне и ноутбуке, где сам бас не слышен' },
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
// Bass and treble: the two-knob tone control, for those who want nothing more. Each knob moves a
// few of the frequency bands together, so the two views always agree.
const TONE = [
  { id: 'bass', name: 'Бас', short: 'Бас', hint: 'Весь низ голоса: вверх — глубже и крупнее, вниз — легче' },
  { id: 'treble', name: 'Верх', short: 'Верх', hint: 'Вся яркость и чёткость: вверх — звонче, вниз — мягче' },
].map((p) => ({ ...p, tone: true, min: -12, max: 12, format: dbFormat }));
PARAMS.push(...TONE);

// A preset is a frequency curve (the eight bands, dB) plus processing. Bands left out are flat.
const PRESETS = {
  // Built by auto-setup from the user's own voice (state.autoPreset): the one meant to be used.
  auto: { name: 'Под вас', hue: 262, v: null, eq: null },
  // Close and natural: a little body, the box taken out, light control. Nothing calls attention to itself.
  studio: { name: 'Подкаст', hue: 212, v: { density: 55, multiband: 40, sat: 25, excite: 15, deess: 55, space: 0, width: 0, pitch: 0 }, eq: { f100: 3, f400: -3, f3200: 2, f11000: 2 } },
  // The FM announcer: big lows, scooped lower middle, bright top, held firmly in place.
  radio: { name: 'Эфир', hue: 28, v: { density: 78, multiband: 80, sat: 50, excite: 35, deess: 65, space: 0, width: 0, pitch: 0 }, eq: { f100: 5, f200: 2, f400: -4, f800: -2, f3200: 3, f6000: 2, f11000: 4 } },
  // Cuts through game sound and music: lean lows, a lot of presence, dense.
  crystal: { name: 'Стрим', hue: 176, v: { density: 80, multiband: 60, sat: 20, excite: 40, deess: 70, space: 0, width: 0, pitch: 0 }, eq: { f100: 2, f400: -3, f1600: 1, f3200: 5, f6000: 3, f11000: 3 } },
  // Late-night voice-over: deep and soft, the top rounded off, thick with low harmonics.
  velvet: { name: 'Бархат', hue: 278, v: { density: 65, multiband: 55, sat: 70, excite: 10, deess: 70, space: 0, width: 0, pitch: 0 }, eq: { f100: 6, f200: 3, f400: -4, f3200: -1, f6000: -2, f11000: 2 } },
  // The trailer: large, squeezed hard, with a room around it.
  cinema: { name: 'Кино', hue: 348, v: { density: 85, multiband: 70, sat: 60, excite: 25, deess: 60, space: 18, width: 40, pitch: 0 }, eq: { f100: 6, f200: 2, f400: -3, f3200: 3, f11000: 4 } },
  // Almost untouched: for calls where the voice should simply be clear.
  whisper: { name: 'Чистый', hue: 140, v: { density: 35, multiband: 20, sat: 0, excite: 10, deess: 50, space: 0, width: 0, pitch: 0 }, eq: { f100: 1, f400: -2, f3200: 2, f11000: 1 } },
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
  eqTab: 'simple', // which bank the equalizer shows: 'simple' (bass and treble), 'freq' or 'tone' (processing)
  loud: 0, // output loudness to hold, LUFS; 0 = leave it
  dehum: false, // notch out 50 Hz mains hum
  autoUpdate: true, // ask GitHub for a newer release at start
  aiVoice: '', // the chosen AI voice (id of an imported model)
  aiPitch: 0, // semitones for AI conversion
  aiSpeaker: 50, // which of the open model's timbres
  voiceLevels: null, // third-octave spectrum of the user's own voice (dB), measured by auto-setup
  autoPreset: null, // { v, eq, about } — the sound auto-setup designed for this voice
  voiceF0: 0, // the user's speaking pitch, Hz, measured by auto-setup: voices that mean "another person" aim from it
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
  // Fixed places: the profile in 0-5, your bands from 6 on — the module puts boosts among those behind the compressor.
  const profile = Array.from({ length: 6 }, (_, i) => mic.bands[i] || [0, 0, 0]);
  return { hp: mic.hp, bands: [...profile, ...own] };
}
const hzText = (f) => (f >= 1000 ? `${String(f / 1000).replace('.', ',')} кГц` : `${f} Гц`);
const dbText = (g) => `${g > 0 ? '+' : '−'}${String(Math.abs(g)).replace('.', ',')} дБ`;

// Everything the module (or the file renderer, which is the same chain) needs to know.
// `clean`: for the neural voice. The network re-synthesises the timbre, so tone shaping ahead of it
// is lost; what does reach the listener is a clean, even input. With `clean`, only that is kept —
// noise suppression, the low cut, hum filter, pause threshold, levelling — and the equalizer,
// harmonics, room, width and effects are left out.
function systemLines(enabled, live = true, clean = false) {
  const v = state.v;
  return [
    `enabled=${enabled ? 1 : 0}`,
    'warmth=0', 'clarity=0', 'air=0', // the tone is in the frequency bands (m…) now
    ...['density', 'multiband', 'sat', 'excite', 'deess', 'space', 'width', 'pitch'].map((k) => `${k}=${clean && k !== 'density' ? 0 : v[k] ?? 0}`),
    `auto=${state.auto ? 1 : 0}`,
    `clean=${state.g.clean}`,
    `ns=${state.g.ns}`,
    `nsengine=${state.nsEngine}`,
    ...(live ? [`playid=${state.playId}`, `playstop=${state.playStop}`, `clipgain=${state.clipGain}`, `mute=${state.mute ? 1 : 0}`] : []),
    `pop=${state.g.pop}`,
    `dereverb=${state.g.dereverb}`,
    `loud=${state.loud || 0}`,
    `dehum=${state.dehum ? 1 : 0}`,
    ...(live ? [`ailive=${aiLiveOn ? 1 : 0}`] : []), // the module plays the voice the window converts
    ...Object.entries(clean ? FX_ZERO : fxValues()).map(([k, value]) => `${k}=${value}`),
    `ingain=${state.inGain}`,
    `outgain=${state.outGain}`,
    `michp=${eqBands().hp}`,
    ...Array.from({ length: 14 }, (_, i) => (clean ? null : eqBands().bands[i]) || [0, 0, 0]).flatMap(([f, g, q], i) => {
      const k = '123456789abcde'[i];
      return [`m${k}f=${f}`, `m${k}g=${g}`, `m${k}q=${q}`];
    }),
  ].join('\r\n') + '\r\n';
}
function pushSystem() {
  if (!sys.installed || TEST) return;
  // Off, "hold to compare" and sample recording all want the untouched microphone.
  window.auraSystem.write(systemLines(state.on && !holdingOriginal && !recording, true, aiLiveOn)); // live AI voice: the module feeds the network the clean voice
}

function applyAll() {
  engine.apply(state, false, fxValues()); // the in-app chain mirrors the effects, so «Проба» lets you hear them
  pushSystem();
  queueSampleRender();
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
  if (sys.outdated && !sys.detached) {
    title = 'Модуль в микрофоне нужно обновить';
    text = 'aura.txt обновилась, а в микрофоне ещё работает прежний модуль. Windows спросит права администратора, звук прервётся на пару секунд.';
    action = 'Обновить модуль';
  } else if (sys.detached) {
    title = 'Windows отключила модуль';
    text = 'Так бывает после обновления Windows или драйвера микрофона. Встройте модуль заново — настройки сохранятся.';
    action = 'Встроить заново';
  } else if (!sys.installed) {
    title = 'Встроить aura.txt в микрофон';
    text = 'Обработанный голос услышат все программы — без виртуального кабеля. Windows спросит права администратора, звук в системе прервётся на пару секунд.';
    action = 'Встроить';
  } else if (silent) {
    title = 'Windows не запустила модуль';
    text = 'Пока модуль в таком состоянии, микрофон может не работать и в других программах. «Убрать» вернёт микрофон как был; после этого модуль можно встроить заново.';
    action = 'Убрать';
  } else {
    title = 'aura.txt встроена в микрофон';
    text = sys.alive ? 'Модуль работает. Голос остаётся обработанным, даже когда это окно закрыто.' : 'Включите сферу, чтобы проверить, что модуль работает.';
    action = 'Убрать';
  }
  renderVoices();
  card.classList.toggle('warn', silent || !!sys.detached || !!sys.outdated);
  // The card lives on the Settings page: flag the tab when it needs attention.
  tabButtons.find((b) => b.dataset.tab === 'setup').classList.toggle('attention', silent || !!sys.detached || !!sys.outdated);
  $('#sysTitle').textContent = title;
  $('#sysText').textContent = sysMessage || text;
  btn.textContent = sysBusy ? 'Подождите…' : action;
  btn.disabled = alt.disabled = sysBusy;
  alt.hidden = true;
  btn.dataset.action = sys.installed && !sys.detached && !sys.outdated ? 'uninstall' : 'install';
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
  const ms = (state.g.ns > 0 ? (deep ? 30 : 10) : 0) + (state.g.dereverb > 0 ? 5 : 0) + (shifted ? 25 : 0);
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
/* ───────── core.txt: the shared settings page ─────────
 * The dev.txt launcher shows the everyday settings of every app on one page. Aura describes its
 * own to the launcher's hub and takes changes back (kit.txt, hub/PROTOCOL.md, "Настройки
 * приложения"). Labels and values are read from this window's own controls, and a change is made
 * by operating the same control — so the launcher and the window can never disagree. */
const HUB_SWITCHES = ['auto', 'monitor', 'dehum', 'autostart', 'autoUpdate'];
const HUB_SELECTS = ['nsEngine', 'loudTarget'];
// section — общая страница core.txt, где показать пункт вместо страницы aura.txt («startup» — «Запуск и обновления»)
const hubSwitch = (id, section) => {
  const el = $('#' + id);
  const label = el?.closest('label');
  if (!el || !label || el.disabled) return null;
  const item = { key: id, type: 'switch', label: label.querySelector('b')?.textContent || id, hint: label.querySelector('small')?.textContent || '', value: el.checked };
  if (section) item.section = section;
  return item;
};
const hubSelect = (id) => {
  const el = $('#' + id);
  if (!el || el.disabled || !el.options.length) return null;
  const short = (text) => text.split(' — ')[0].trim(); // "Обычный — RNNoise, 10 мс" → "Обычный"
  return {
    key: id, type: 'choice', label: el.closest('label')?.querySelector('span')?.textContent || id, value: el.value,
    options: [...el.options].map((o) => ({ value: o.value, label: short(o.textContent) })),
  };
};
function hubSettingsNow() {
  const only = (items) => items.filter(Boolean);
  return {
    groups: [
      { title: '', items: only([
        { key: 'power', type: 'switch', label: 'Обработка голоса', hint: 'Включает и выключает aura.txt', value: engine.running },
        { key: 'preset', type: 'choice', label: 'Готовый звук', value: state.preset, options: Object.entries(PRESETS).map(([id, p]) => ({ value: id, label: p.name })) },
        sys.installed ? { key: 'mute', type: 'switch', label: 'Заглушить микрофон', hint: 'Тишина для всех программ', value: !!state.mute } : null,
        hubSwitch('auto'),
        hubSwitch('monitor'),
      ]) },
      { title: 'Звук', items: only([hubSelect('nsEngine'), hubSelect('loudTarget'), hubSwitch('dehum')]) },
      { title: 'Запуск и обновления', items: only([hubSwitch('autostart', 'startup'), hubSwitch('autoUpdate', 'startup')]) },
    ],
  };
}
let hubTimer = 0;
let hubLast = '';
// Debounced, and sent only when something really changed
function publishHubSettings() {
  if (!window.auraSystem?.hubSettings || TEST || PROBE || DATA) return;
  clearTimeout(hubTimer);
  hubTimer = setTimeout(() => {
    const now = hubSettingsNow();
    const text = JSON.stringify(now);
    if (text === hubLast) return;
    hubLast = text;
    window.auraSystem.hubSettings(now);
  }, 120);
}
async function applyHubSetting(key, value) {
  if (key === 'power') return setPower(!!value);
  if (key === 'preset') {
    if (!PRESETS[value]) throw new Error('такого звука нет');
    return selectPreset(value);
  }
  if (key === 'mute') {
    if (!sys.installed) throw new Error('aura.txt не встроена в микрофон');
    $('#mute').checked = state.mute = !!value;
    save();
    pushSystem();
    return reportToTray();
  }
  const el = HUB_SWITCHES.includes(key) || HUB_SELECTS.includes(key) ? $('#' + key) : null;
  if (!el || el.disabled) throw new Error('такой настройки нет');
  if (el.type === 'checkbox') el.checked = !!value;
  else {
    if (![...el.options].some((o) => o.value === String(value))) throw new Error('такого варианта нет');
    el.value = String(value);
  }
  el.dispatchEvent(new Event('change', { bubbles: true })); // the control's own handler does the rest
}
// The shared look: one accent colour for every dev.txt app (or Aura's own, by the character), and
// "less motion" switched on for the whole ecosystem.
function applyHubTheme(theme) {
  const root = document.documentElement;
  const accent = theme && /^#[0-9a-f]{6}$/i.test(theme.accent || '') ? theme.accent : null;
  const vars = [
    ['--accent', accent],
    ['--accent-solid', accent && 'color-mix(in srgb, ' + accent + ', black 12%)'],
    ['--accent-tint', accent && 'color-mix(in srgb, ' + accent + ' 22%, transparent)'],
  ];
  for (const [name, value] of vars) {
    if (value) root.style.setProperty(name, value); else root.style.removeProperty(name);
  }
  root.toggleAttribute('data-reduced-motion', !!theme?.reducedMotion);
}
function startHubSettings() {
  const bridge = window.auraSystem;
  if (!bridge?.onHubCommand) return;
  bridge.onHubCommand(async (id, kind, key, value) => {
    try {
      if (kind !== 'set') throw new Error('такой команды нет');
      await applyHubSetting(key, value);
      bridge.hubResult(id, true);
    } catch (e) {
      bridge.hubResult(id, false, String(e?.message || e));
    }
    hubLast = ''; // answer with the full picture even if nothing changed: the launcher is waiting for it
    publishHubSettings();
  });
  bridge.onHubTheme(applyHubTheme);
  bridge.hubTheme().then(applyHubTheme, () => {});
  // Anything changed in this window by hand reaches the launcher too
  document.addEventListener('change', publishHubSettings);
  setInterval(publishHubSettings, 3000); // and what changes without a click: the module appearing, a select being filled
  publishHubSettings();
}

// Keep the tray icon and its menu in step with the window.
function reportToTray() {
  publishHubSettings();
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
  if (id === 'auto' && !state.autoPreset) return flash('Нажмите «Автонастройка» — она соберёт звук под ваш голос', true, 6000);
  state.preset = id;
  const from = id === 'custom' ? state.custom || { v: state.v, eq: state.eq } : id === 'auto' ? state.autoPreset : PRESETS[id];
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
  if (data.error) return flash('Это не файл пресета aura.txt', true);
  // Only the sound travels in a file; room settings (noise, echo, gate) stay yours.
  const v = {};
  const eq = {};
  for (const p of PARAMS.filter((q) => !q.global && !q.tone)) {
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
const toneBank = {
  get bass() { return state.eq.f100 || 0; },
  set bass(v) { state.eq.f100 = v; state.eq.f200 = Math.round(v / 2); },
  get treble() { return state.eq.f11000 || 0; },
  set treble(v) { state.eq.f11000 = v; state.eq.f6000 = Math.round(v * 0.6); state.eq.f3200 = Math.round(v * 0.3); },
};
const bank = (p) => (p.tone ? toneBank : p.eq ? state.eq : p.global ? state.g : state.v);
const show = (p, v) => (p.format ? p.format(Number(v)) : String(v));
// One instrument instead of a column of sliders: every setting is a band of an equalizer, and a
// glowing curve runs through the handles, so a character reads as a shape. Two banks: what the
// voice is like (presets move these) and what the room needs (they stay yours).
const EQ_IDLE = ['Эквалайзер голоса', 'Две ручки — «Бас и верх». Тоньше — во вкладке «Частоты». Наведите на полосу — здесь появится, что она меняет'];
slidersEl.innerHTML = `<div class="eq-head"><b id="eqName"></b><em id="eqValue"></em><small id="eqHint"></small></div>
<div class="eq-tools"><div class="segmented eq-tabs" id="eqTabs" role="radiogroup" aria-label="Что показывает эквалайзер"><button type="button" role="radio" data-bank="simple">Бас и верх</button><button type="button" role="radio" data-bank="freq">Частоты</button><button type="button" role="radio" data-bank="tone">Обработка</button></div><button type="button" class="link" id="eqReset">Сбросить частоты</button></div>
<div class="eq-body"><svg class="eq-curve" aria-hidden="true"><defs><linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="eq-stop-a"/><stop offset="1" class="eq-stop-b"/></linearGradient></defs></svg>
<div class="eq-bank simple" data-bank="simple" data-title="Бас и верх, дБ"></div><div class="eq-bank" data-bank="tone" data-title="Обработка"></div><div class="eq-bank" data-bank="freq" data-title="Частоты, дБ"></div><div class="eq-bank room" data-title="Комната и микрофон"></div></div>`;
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
  const eqBank = eqBanks.find((b) => (p.global ? b.el.classList.contains('room') : b.el.dataset.bank === (p.tone ? 'simple' : p.eq ? 'freq' : 'tone')));
  eqBank.inputs.push(input);
  label.addEventListener('pointerenter', () => eqShow(p, input));
  input.addEventListener('focus', () => eqShow(p, input));
  input.addEventListener('blur', () => eqShow(null));
  input.addEventListener('input', () => eqShow(p, input));
  input.addEventListener('input', () => {
    bank(p)[p.id] = Number(input.value);
    value.textContent = show(p, input.value);
    fill(input);
    if (p.tone || p.eq) renderSliders(); // the two-knob view and the bands are the same thing seen twice
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
  state.eqTab = ['simple', 'freq', 'tone'].includes(tab) ? tab : 'simple';
  for (const b of $('#eqTabs').children) b.setAttribute('aria-checked', String(b.dataset.bank === state.eqTab));
  for (const b of eqBanks) if (b.el.dataset.bank) b.el.hidden = b.el.dataset.bank !== state.eqTab;
  $('#eqReset').hidden = state.eqTab === 'tone' || !FREQS.some((p) => state.eq[p.id]);
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
  showEqTab(state.eqTab);
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
    el.textContent = 'aura.txt встроена в микрофон: в Discord, OBS и играх ничего переключать не нужно, выбирайте свой обычный микрофон.';
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
    else if (sampleRaw) engine.playBuffer(sampleRaw.matched || sampleRaw.buffer);
    else engine.setBypass(true);
  } else {
    // Undo both ways of bypassing, whichever one the press used: the mode may have changed meanwhile.
    holdingOriginal = false;
    if (sampleRaw && engine.sampleMode && sampleRendered) engine.playBuffer(sampleRendered);
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

/* ───────── Sample loop ─────────
 * With the module installed, the recorded sample is rendered by the module's own chain (the
 * AuraRender tool) on every change, so what loops is exactly what goes on air — denoiser,
 * broadcast compressor and all. Without the tool, the in-app chain plays it instead. */
let sampleRaw = null; // { mono: Float32Array, buffer: AudioBuffer }
let sampleRendered = null;
let sampleTimer = 0;
let sampleBusy = false;
let sampleAgain = false;
const toBuffer = (interleaved, channels) => {
  const frames = interleaved.length / channels;
  const buf = engine.ctx.createBuffer(2, frames, 48000);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    const from = Math.min(c, channels - 1);
    for (let i = 0; i < frames; i++) d[i] = interleaved[i * channels + from];
  }
  return buf;
};
async function renderSampleNow() {
  if (!sampleRaw || !engine.sampleMode) return;
  if (sampleBusy) return (sampleAgain = true);
  sampleBusy = true;
  const out = await window.auraSystem.renderSample(sampleRaw.mono.slice().buffer, systemLines(true, false));
  sampleBusy = false;
  if (out && sampleRaw && engine.sampleMode) {
    sampleRendered = toBuffer(new Float32Array(out), 2);
    // Louder always sounds better, so the untouched take is played as loud as the processed one:
    // what is compared is the tone and the cleanliness, not the volume.
    const power = (d) => { let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return s / d.length; };
    const lift = Math.min(10, Math.sqrt(power(sampleRendered.getChannelData(0)) / (power(sampleRaw.mono) + 1e-12)));
    let peak = 0;
    for (const s of sampleRaw.mono) peak = Math.max(peak, Math.abs(s));
    const g = Math.min(lift, 0.98 / (peak + 1e-9));
    sampleRaw.matched = toBuffer(sampleRaw.mono.map((s) => s * g), 1);
    if (!held) engine.playBuffer(sampleRendered);
  }
  if (sampleAgain) {
    sampleAgain = false;
    renderSampleNow();
  }
}
function queueSampleRender() {
  if (!sampleRaw || !engine.sampleMode) return;
  clearTimeout(sampleTimer);
  sampleTimer = setTimeout(renderSampleNow, 90);
}
// Loops a take through the module's own chain: used by «Проба» and by auto-setup's before/after.
function startSample(mono) {
  sampleRaw = { mono, buffer: toBuffer(mono, 1) };
  sampleRendered = null;
  engine.playBuffer(sampleRaw.buffer); // the raw take for the moment the first render takes
  renderSampleNow();
  syncBypass();
  pushSystem();
  renderSample();
}
const sampleBtn = $('#sample');
// The fitting room: the user's own phrase loops, and every voice clicked is heard on it at once —
// no talking, no hearing oneself late through the headphones.
function renderFit() {
  const on = engine.sampleMode;
  const btn = $('#fitBtn');
  btn.textContent = on ? 'Закончить' : 'Примерить';
  btn.classList.toggle('live', on);
  $('#fitText').textContent = on
    ? 'Играет ваша запись. Нажимайте голоса — она сразу зазвучит по-новому. Кнопка «Оригинал» вверху возвращает ваш настоящий голос, пока её держите.'
    : `Ваша запись заиграет по кругу, а голоса будут меняться на ней по нажатию.${state.voiceF0 ? ` Девушка, Парень, Ребёнок, Великан и Демон подстроены под высоту вашего голоса (${state.voiceF0} Гц).` : ' После «Автонастройки» голоса подстроятся под высоту вашего голоса.'}`;
}
$('#fitBtn').addEventListener('click', async () => {
  if (recording || tuning) return;
  if (!engine.running) return flash('Сначала включите сферу', true);
  if (engine.sampleMode) {
    engine.stopSample();
    sampleRaw = sampleRendered = null;
    syncBypass();
    pushSystem();
    renderSample();
    liveStatus();
    return;
  }
  const stored = sys.installed && (await window.auraSystem.renderAvailable()) ? await window.auraSystem.loadTake() : null;
  if (stored) startSample(new Float32Array(stored));
  else sampleBtn.click(); // nothing recorded yet: record six seconds first
});
function renderSample() {
  renderFit();
  sampleBtn.classList.toggle('live', engine.sampleMode || recording);
  if (!recording) sampleBtn.textContent = engine.sampleMode ? 'Остановить пробу' : 'Записать пробу';
}
sampleBtn.addEventListener('click', async () => {
  if (recording || !engine.running) return;
  if (engine.sampleMode) {
    engine.stopSample();
    sampleRaw = sampleRendered = null;
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
      sampleRaw = sampleRendered = null;
      if (sys.installed && (await window.auraSystem.renderAvailable())) {
        const b = engine.sampleBuf;
        const mono = new Float32Array(b.length);
        for (let c = 0; c < b.numberOfChannels; c++) {
          const d = b.getChannelData(c);
          for (let i = 0; i < mono.length; i++) mono[i] += d[i] / b.numberOfChannels;
        }
        window.auraSystem.saveTake(mono.slice().buffer);
        startSample(mono);
      } else {
        engine.playSample();
      }
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
$('#padClown').addEventListener('click', async () => {
  const found = await window.auraSystem.importClownfish();
  if (found === null) return flash('Clownfish на этом компьютере не найден', true);
  // Skip what was brought over before: the same button twice must not double the board.
  const have = new Set(state.pads.filter((p) => p.source === 'clownfish').map((p) => p.name));
  const fresh = found.filter((p) => !have.has(p.name));
  for (const p of found) if (!fresh.includes(p)) window.auraSystem.removeSound(p.id);
  if (!fresh.length) return flash('Звуки из Clownfish уже перенесены');
  state.pads.push(...fresh);
  padsChanged();
  flash(`Перенесено звуков из Clownfish: ${fresh.length}`, false, 5000);
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
const FX_ZERO = { fxpitch: 0, fxnatural: 0, fxformant: 0, fxring: 0, fxringmix: 0, fxecho: 0, fxechofb: 0, fxechomix: 0, fxphone: 0, fxdrive: 0, fxtrem: 0, fxtremdepth: 0, fxlp: 0, fxspace: 0, fxchorus: 0, fxcrush: 0, fxmutate: 0 };
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
  girl: { name: 'Девушка', hint: 'Выше и легче тембром', icon: 'person', color: '#ff375f', p: { fxpitch: 5, fxnatural: 1, fxformant: 2.8 }, fit: [215, 0.5] },
  guy: { name: 'Парень', hint: 'Ниже и плотнее тембром', icon: 'person', color: '#0a84ff', p: { fxpitch: -4, fxnatural: 1, fxformant: -2.4 }, fit: [105, 0.55] },
  kid: { name: 'Ребёнок', hint: 'Высокий и маленький', icon: 'child', color: '#ff9f0a', p: { fxpitch: 8, fxnatural: 1, fxformant: 4 }, fit: [300, 0.45] },
  higher: { name: 'Выше', hint: 'Тот же человек, тоньше', icon: 'up', color: '#30b0c7', p: { fxpitch: 3, fxnatural: 1 } },
  lower: { name: 'Ниже', hint: 'Тот же человек, глубже', icon: 'down', color: '#5e5ce6', p: { fxpitch: -3, fxnatural: 1 } },
  helium: { name: 'Гелий', hint: 'Как после шарика', icon: 'balloon', color: '#ff453a', p: { fxpitch: 7 } },
  chipmunk: { name: 'Бурундук', hint: 'Совсем тоненький', icon: 'note', color: '#a2845e', p: { fxpitch: 11 } },
  giant: { name: 'Великан', hint: 'Низкий и большой', icon: 'mountain', color: '#34c759', p: { fxpitch: -6 }, fit: [75] },
  demon: { name: 'Демон', hint: 'Низко, с хрипом и залом', icon: 'flame', color: '#d70015', p: { fxpitch: -8, fxdrive: 30, fxspace: 50 }, fit: [68] },
  robot: { name: 'Робот', hint: 'Металлический, ровный', icon: 'cpu', color: '#64748b', p: { fxring: 55, fxringmix: 85 } },
  alien: { name: 'Пришелец', hint: 'Звенящий, не отсюда', icon: 'star', color: '#30d158', p: { fxring: 190, fxringmix: 60, fxpitch: 3 } },
  phone: { name: 'Телефон', hint: 'Узкая полоса, как в трубке', icon: 'phone', color: '#34c759', p: { fxphone: 1 } },
  radio: { name: 'Рация', hint: 'Трубка с перегрузом', icon: 'radio', color: '#ff9500', p: { fxphone: 1, fxdrive: 55 } },
  megaphone: { name: 'Мегафон', hint: 'Громкоговоритель на площади', icon: 'megaphone', color: '#ff6b00', p: { fxphone: 1, fxdrive: 80, fxecho: 90, fxechofb: 20, fxechomix: 25 } },
  cave: { name: 'Пещера', hint: 'Долгое эхо', icon: 'cave', color: '#8e5bd9', p: { fxecho: 260, fxechofb: 50, fxechomix: 45, fxspace: 80 } },
  hall: { name: 'Собор', hint: 'Большой гулкий зал', icon: 'columns', color: '#af52de', p: { fxspace: 100 } },
  underwater: { name: 'Под водой', hint: 'Глухо и с бульканьем', icon: 'waves', color: '#32ade6', p: { fxlp: 600, fxtrem: 5, fxtremdepth: 50 } },
  shaky: { name: 'Дрожащий', hint: 'Голос трясётся', icon: 'pulse', color: '#00c7be', p: { fxtrem: 8, fxtremdepth: 70 } },
  chorus: { name: 'Хор', hint: 'Вас становится несколько', icon: 'waves', color: '#5ac8fa', p: { fxchorus: 55 } },
  clone: { name: 'Клоны', hint: 'Толпа одинаковых голосов', icon: 'person', color: '#bf5af2', p: { fxchorus: 100, fxecho: 45, fxechofb: 10, fxechomix: 25 } },
  atari: { name: 'Приставка', hint: 'Восемь бит, как в старой игре', icon: 'cpu', color: '#ff9f0a', p: { fxcrush: 70 } },
  mutant: { name: 'Мутант', hint: 'Высота скачет сама', icon: 'pulse', color: '#30d158', p: { fxmutate: 100 } },
  ghost: { name: 'Призрак', hint: 'Глухой, далёкий, с эхом', icon: 'cave', color: '#8e8e93', p: { fxpitch: -2, fxlp: 2200, fxecho: 180, fxechofb: 55, fxechomix: 50, fxspace: 90, fxchorus: 40 } },
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
// "A girl", "a guy", "a giant" are places on the pitch scale, not distances: from a low voice the
// way to a girl's is long, from a high one short. Once auto-setup has measured the speaking pitch,
// these voices aim at their place from it (and move the timbre in proportion); until then they
// use their fixed step.
function voiceParams(id) {
  const voice = VOICES[id] || VOICES.none;
  if (!voice.fit || !state.voiceF0) return voice.p;
  const [target, timbreShare] = voice.fit;
  const st = clamp(Math.round(12 * Math.log2(target / state.voiceF0)), -12, 12);
  const p = { ...voice.p, fxpitch: st };
  if (voice.p.fxnatural) p.fxformant = clamp(Math.round(st * timbreShare * 10) / 10, -5, 5);
  return p;
}
function fxValues() {
  return { ...FX_ZERO, ...(state.fx === 'custom' ? customFx() : voiceParams(state.fx)) };
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
  // padNames — для страницы «Клавиши» в core.txt: там у звука видно его название
  const failed = await window.auraSystem.setHotkeys({ power: state.hotkeys.power, mute: state.hotkeys.mute, pads: state.pads.map((p) => p.key || null), padNames: state.pads.map((p) => p.name), voices: Object.entries(state.fxKeys) });
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
  if (name === 'voice') queueEq();
  if (name === 'ai') renderAi();
  if (name === 'sounds' && !catalog.started) {
    catalog.started = true; // nothing is fetched until the user actually opens the page
    loadCatalog(true);
  }
}
for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));
// core.txt просит открыть страницу (show с page). Своё место здесь есть только у горячих клавиш — внизу «Настроек».
function openPage(page) {
  if (page !== 'keys') return;
  showTab('setup');
  const title = $('#keysTitle');
  const calm = REDUCED_MOTION || document.documentElement.hasAttribute('data-reduced-motion');
  requestAnimationFrame(() => title.scrollIntoView({ block: 'start', behavior: calm ? 'auto' : 'smooth' }));
  // Список микрофонов выше мог дорисоваться и сдвинуть раздел, а плавная прокрутка — не дойти: тогда сразу на место
  setTimeout(() => {
    const page = title.parentElement.getBoundingClientRect();
    const top = Math.max(page.top, 0), bottom = Math.min(page.bottom, innerHeight);
    const keys = (title.nextElementSibling || title).getBoundingClientRect();
    if (title.getBoundingClientRect().top < top || keys.bottom > bottom) title.scrollIntoView({ block: 'start' });
  }, 900);
}
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
  engineSelect.options[1].textContent = deep === -1 ? 'Жёсткий — отключён после сбоя, выберите, чтобы попробовать снова' : 'Жёсткий — DeepFilterNet, 30 мс: давит шум сильнее, но меняет голос';
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
function spectrumMeter(size = 4096) {
  const an = engine.ctx.createAnalyser();
  an.fftSize = size;
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
      return { frames, hz, bins: frames ? Array.from(sum, (p) => p / frames) : [], bands: THIRDS.map((f) => {
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
  return { hp: 80, bands, levels: THIRDS.map((_, k) => (Number.isFinite(diff[k]) ? Math.round((diff[k] + SPEECH[k]) * 10) / 10 : null)) };
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

  const quiet = spectrumMeter(16384); // fine enough to tell mains hum from rumble
  const noise = percentile(await listen(3, 'Помолчите три секунды — слушаю комнату', () => quiet.grab()), 0.5);
  const talk = spectrumMeter();
  // The speech is also kept as a recording: it becomes the before/after at the end.
  const rec = new MediaRecorder(engine.stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const recorded = new Promise((r) => (rec.onstop = r));
  rec.start();
  const levels = await listen(8, 'Говорите как обычно — расскажите, что делали сегодня', (db) => db > noise + 12 && talk.grab()); // only while the voice is there
  rec.stop();
  await recorded;
  const speech = percentile(levels, 0.8);
  const room = quiet.done();
  const eq = measuredEq(talk.done(), room);
  let take = null;
  try {
    take = await decodeMono(new Blob(chunks, { type: rec.mimeType }));
  } catch {}
  holdingOriginal = false;
  tuning = false;
  tuneBtn.classList.remove('live');

  if (speech < noise + 6) {
    pushSystem();
    flash('Не расслышал голос. Попробуйте ещё раз, ближе к микрофону.', true);
    return;
  }
  setStatus('Собираю звук под ваш голос…');
  // 1. Level, room and noise.
  const gain = clamp(Math.round(-26 - speech), -12, 18);
  const snr = speech - noise;
  // The neural denoiser does the cleaning; the pause threshold only has to sit a little above the
  // room. Set high, it eats the quiet starts and ends of words — that is heard as a torn voice.
  state.g.clean = clamp(Math.round((noise + gain + 8 + 65) / 0.4), 5, 70);
  // Measured on clean speech: the ordinary engine at 60 changes the voice by well under a dB,
  // the hard one by 2-5 dB (it eats quiet consonants and word endings). So the ordinary one, at
  // the strength that removes steady noise without touching the voice; a little less in a quiet room.
  state.g.ns = snr > 45 ? 50 : 60;
  state.nsEngine = 0;
  renderEngine();
  state.g.pop = 50;
  state.auto = true;
  $('#auto').checked = true;
  const hum = humLevel(room);
  state.dehum = hum > 10;
  $('#dehum').checked = state.dehum;
  // 2. The microphone itself: flattened towards an average voice through a flat microphone.
  let bright = 0;
  if (eq) {
    bright = brightness(eq.levels);
    state.voiceLevels = eq.levels;
    delete eq.levels;
    state.micMeasured = eq;
    state.mic = 'measured';
    renderMic();
  }
  // 3. The voice: its pitch, how much its level wanders, how bright it is — and a sound built on that.
  const f0 = take ? voicePitch(take) : 0;
  if (f0) state.voiceF0 = Math.round(f0);
  if (take) window.auraSystem.saveTake(take.slice().buffer); // the effects page tries voices on it
  const active = levels.filter((l) => l > noise + 12);
  const spread = active.length > 10 ? percentile(active, 0.9) - percentile(active, 0.3) : 8;
  state.autoPreset = designVoice({ f0, snr, spread, bright });
  if (state.micMeasured) state.micMeasured.hp = state.autoPreset.hp;
  renderMic();
  state.loud = -16; // a podcast's loudness: consistent, and clearly fuller than a bare microphone
  loudSelect.value = '-16';
  const gainInput = $('#inGain');
  gainInput.value = gain;
  gainInput.dispatchEvent(new Event('input')); // updates the label, applies and saves
  state.tuned = true;
  selectPreset('auto'); // applies, saves, tells the tray
  renderGuide();
  // 4. Before and after, on the user's own words.
  const told = `${state.autoPreset.about}${state.dehum ? ', гул сети убран' : ''}`;
  if (take && sys.installed && (await window.auraSystem.renderAvailable())) {
    startSample(take);
    flash(`Готово. Играет ваша запись с новым звуком — удерживайте «Оригинал», чтобы услышать, как было (громкость уравнена, сравнивается сам звук). ${told}`, false, 15000);
  } else {
    flash(`Готово: ${told}`, false, 9000);
  }
});

// How far mains hum (50 Hz and its first harmonics) stands above what surrounds it, dB.
function humLevel(room) {
  if (!room.bins.length) return 0;
  let worst = 0;
  for (const f of [50, 100, 150]) {
    const at = Math.round(f / room.hz);
    let peak = 0;
    for (let i = at - 1; i <= at + 1; i++) peak = Math.max(peak, room.bins[i] || 0);
    const around = [];
    for (let i = at - 8; i <= at + 8; i++) if (Math.abs(i - at) >= 4 && room.bins[i] > 0) around.push(room.bins[i]);
    around.sort((x, y) => x - y);
    const floor = around[around.length >> 1];
    if (peak > 0 && floor > 0) worst = Math.max(worst, 10 * Math.log10(peak / floor));
  }
  return worst;
}
// Is the top of the voice (5-10 kHz) above or below where an average voice has it, dB.
function brightness(levels) {
  const mean = (lo, hi) => {
    const xs = levels.map((v, k) => (v != null && THIRDS[k] >= lo && THIRDS[k] <= hi ? v - SPEECH[k] : null)).filter((v) => v != null);
    return xs.length ? xs.reduce((p, c) => p + c, 0) / xs.length : 0;
  };
  return mean(5000, 10000) - mean(200, 4000);
}
// The speaking pitch: the median over the clearly voiced moments of the take, Hz (0 = not found).
function voicePitch(mono) {
  const W = 1920, found = [];
  let top = 0;
  for (let i = 0; i < mono.length; i += 97) top = Math.max(top, Math.abs(mono[i]));
  for (let at = 0; at + W + 800 < mono.length; at += 1920) {
    let e0 = 1e-12;
    for (let i = 0; i < W; i += 2) e0 += mono[at + i] * mono[at + i];
    if (Math.sqrt(e0 / (W / 2)) < top * 0.08) continue; // a pause
    let best = 0, lag0 = 0;
    for (let lag = 120; lag <= 800; lag += 2) { // 400 … 60 Hz
      let c = 0, e1 = 1e-12;
      for (let i = 0; i < W; i += 2) { c += mono[at + i] * mono[at + i + lag]; e1 += mono[at + i + lag] * mono[at + i + lag]; }
      const s = c / Math.sqrt(e0 * e1);
      if (s > best * 1.03) { best = s; lag0 = lag; }
    }
    if (best > 0.7) found.push(48000 / lag0);
  }
  found.sort((x, y) => x - y);
  return found.length >= 5 ? found[found.length >> 1] : 0;
}
// A broadcast voice for this particular voice. The contour is the engineers' usual one — body
// low down, the boxy lower middle taken out, presence, a little air — placed by the pitch of the
// voice and held back where the measurements say it would hurt: no extra air or sparkle on a
// noisy microphone (it only lifts the hiss), more de-essing on a bright voice, firmer levelling
// for a voice that wanders in level.
function designVoice({ f0, snr, spread, bright }) {
  const kind = !f0 ? 'голос' : f0 < 110 ? 'низкий голос' : f0 < 150 ? 'мужской голос' : f0 < 180 ? 'высокий мужской или низкий женский голос' : 'женский голос';
  const eq = !f0 || (f0 >= 110 && f0 < 150) ? { f100: 5, f200: 1, f400: -3 } // the classic: weight at 100, box out
    : f0 < 110 ? { f100: 3, f200: -1, f400: -3 } // already deep: more would boom
    : f0 < 180 ? { f100: 4, f200: 2, f400: -3 }
    : { f100: 2, f200: 3, f400: -2, f800: -1 }; // a woman's body sits an octave up
  // Every dB of top end is a dB of hiss as well: none on a noisy microphone, a little on a fair one.
  const noisy = snr < 30, fair = snr < 38;
  eq.f3200 = 3;
  if (bright <= 2 && !noisy) eq.f6000 = 1;
  const air = noisy ? 0 : fair ? 2 : bright > 2 ? 3 : 4;
  if (air) eq.f11000 = air;
  const v = {
    density: clamp(Math.round(50 + (spread - 8) * 4), 45, 85),
    multiband: 55,
    sat: f0 && f0 < 110 ? 20 : 35,
    excite: noisy ? 8 : fair ? 15 : 25,
    deess: clamp(Math.round(55 + 5 * bright), 40, 80),
    space: 0, width: 0, pitch: 0,
  };
  const about = `Определил ${kind}${f0 ? ` (около ${Math.round(f0)} Гц)` : ''}${noisy ? ', комната шумная — верх не поднимаю, чтобы не вытащить шипение' : fair ? ', шум заметный — верх поднят осторожно' : ''}`;
  return { v, eq, about, hp: f0 >= 180 ? 100 : f0 && f0 < 110 ? 70 : 80 }; // the low cut sits just under the voice
}

/* ───────── Live spectrum behind the frequency bands ─────────
 * What is leaving the microphone right now, drawn on the same frequency axis as the handles
 * (they sit an octave apart, so the axis between them is logarithmic). */
const specCanvas = document.createElement('canvas');
specCanvas.className = 'eq-spectrum';
specCanvas.setAttribute('aria-hidden', 'true');
eqBody.prepend(specCanvas);
const specCtx = specCanvas.getContext('2d');
const SPEC_POINTS = 56;
const specLevel = new Float32Array(SPEC_POINTS).fill(-100);
let specAn = null;
let specBins = null;
let specLast = 0;
function drawSpectrum(now) {
  const bank = eqBanks.find((b) => b.el.dataset.bank === 'freq');
  if (now - specLast < 45 || bank.el.hidden || !slidersEl.offsetParent) return;
  specLast = now;
  const box = eqBody.getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  if (specCanvas.width !== Math.round(box.width * dpr) || specCanvas.height !== Math.round(box.height * dpr)) {
    specCanvas.width = Math.round(box.width * dpr);
    specCanvas.height = Math.round(box.height * dpr);
  }
  specCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  specCtx.clearRect(0, 0, box.width, box.height);
  if (!engine.running || !engine.n) return specLevel.fill(-100);
  if (!specAn || specAn.context !== engine.ctx) {
    specAn = engine.ctx.createAnalyser();
    specAn.fftSize = 4096;
    specAn.smoothingTimeConstant = 0.6;
    engine.n.post.connect(specAn);
    specBins = new Float32Array(specAn.frequencyBinCount);
  }
  specAn.getFloatFrequencyData(specBins);
  // Where each band's handle sits; frequencies between and beyond are placed on a log scale.
  const marks = bank.inputs.map((input, i) => {
    const r = input.parentElement.getBoundingClientRect();
    return { f: FREQS[i].f, x: r.left + r.width / 2 - box.left, top: r.top - box.top + 8, bottom: r.bottom - box.top - 8 };
  });
  if (!marks.length || !marks[0].bottom) return;
  const xOf = (f) => {
    let i = 0;
    while (i < marks.length - 2 && f > marks[i + 1].f) i++;
    const a = marks[i], b = marks[i + 1];
    return a.x + ((Math.log(f) - Math.log(a.f)) / (Math.log(b.f) - Math.log(a.f))) * (b.x - a.x);
  };
  const edge = bank.el.getBoundingClientRect();
  const left = edge.left - box.left, right = edge.right - box.left;
  const top = marks[0].top, bottom = marks[0].bottom;
  const hz = engine.ctx.sampleRate / specAn.fftSize;
  specCtx.beginPath();
  specCtx.moveTo(left, bottom);
  for (let k = 0; k < SPEC_POINTS; k++) {
    const f = 60 * Math.pow(16000 / 60, k / (SPEC_POINTS - 1));
    let peak = -140;
    for (let i = Math.max(1, Math.floor((f / 1.07) / hz)); i <= Math.ceil((f * 1.07) / hz) && i < specBins.length; i++) if (specBins[i] > peak) peak = specBins[i];
    peak += 3 * Math.log2(f / 1000); // +3 dB per octave: speech falls away towards the top, this keeps the picture level
    specLevel[k] = peak > specLevel[k] ? peak : specLevel[k] + (peak - specLevel[k]) * 0.25;
    const y = bottom - clamp((specLevel[k] + 95) / 65, 0, 1) * (bottom - top);
    specCtx.lineTo(clamp(xOf(f), left, right), y);
  }
  specCtx.lineTo(right, bottom);
  specCtx.closePath();
  specCtx.fillStyle = 'rgba(255, 255, 255, 0.07)';
  specCtx.fill();
  specCtx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  specCtx.lineWidth = 1;
  specCtx.stroke();
}

/* ───────── Decoding files ───────── */
// Any audio or video the browser can decode → mono float32 at 48 kHz.
async function decodeMono(file, maxSeconds = Infinity) {
  const probe = new OfflineAudioContext(1, 1, 48000);
  const decoded = await probe.decodeAudioData(await file.arrayBuffer());
  const seconds = Math.min(decoded.duration, maxSeconds);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(seconds * 48000)), 48000);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}
const pickFile = (accept) =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] || null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });

/* ───────── «Как у образца» ─────────
 * Takes the frequency balance of a recording you like and moves your bands towards it. Needs the
 * spectrum of your own voice, which auto-setup measures. Only the balance is matched — not the
 * other person's microphone, room or compression. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// Third-octave levels (dB) of the louder half of a recording: the pauses say nothing about a voice.
function thirdOctaves(mono) {
  const N = 4096, re = new Float32Array(N), im = new Float32Array(N);
  const frames = [];
  for (let at = 0; at + N <= mono.length; at += N) {
    let e = 0;
    for (let i = 0; i < N; i++) e += mono[at + i] * mono[at + i];
    frames.push([at, e]);
  }
  if (frames.length < 8) return null;
  const median = frames.map((f) => f[1]).sort((a, b) => a - b)[frames.length >> 1];
  const sum = new Float64Array(N / 2);
  let used = 0;
  for (const [at, e] of frames) {
    if (e < median || e <= 0) continue;
    for (let i = 0; i < N; i++) { re[i] = mono[at + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); im[i] = 0; }
    fft(re, im);
    for (let i = 0; i < N / 2; i++) sum[i] += re[i] * re[i] + im[i] * im[i];
    used++;
  }
  const hz = 48000 / N;
  return THIRDS.map((f) => {
    let p = 0;
    for (let i = Math.ceil((f / 1.122) / hz); i < (f * 1.122) / hz && i < sum.length; i++) p += sum[i];
    return p > 0 ? 10 * Math.log10(p / used) : null;
  });
}
// How far a band of the microphone profile moves a frequency, dB (close enough for this purpose).
const bandGainAt = (f, [f0, g, q]) => (q > 0 ? g / (1 + Math.pow((f / f0 - f0 / f) * q, 2)) : f0 < 1000 ? g / (1 + Math.pow(f / f0, 2)) : g / (1 + Math.pow(f0 / f, 2)));
$('#matchRef').addEventListener('click', async () => {
  if (!state.voiceLevels) return flash('Сначала нажмите «Автонастройка»: мне нужен спектр вашего голоса', true, 6000);
  const file = await pickFile('audio/*,video/*');
  if (!file) return;
  setStatus('Слушаю образец…');
  let ref = null;
  try {
    ref = thirdOctaves(await decodeMono(file, 240));
  } catch {}
  if (!ref) return flash('Не получилось прочитать этот файл. Подойдут mp3, wav, m4a, ogg, mp4, webm', true, 6000);
  const shape = (levels, lo, hi) => {
    const xs = levels.filter((v, k) => v != null && THIRDS[k] >= lo && THIRDS[k] <= hi);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const refMid = shape(ref, 200, 4000), ownMid = shape(state.voiceLevels, 200, 4000);
  if (refMid == null || ownMid == null) return flash('В образце слишком мало голоса', true);
  const mic = micEq();
  const eq = {};
  for (const p of FREQS) {
    const lo = p.q ? p.f / 1.3 : p.f < 1000 ? 90 : 8000, hi = p.q ? p.f * 1.3 : p.f < 1000 ? 135 : 12500;
    const r = shape(ref, lo, hi), o = shape(state.voiceLevels, lo, hi);
    if (r == null || o == null) continue;
    const profile = mic.bands.reduce((a, b) => a + bandGainAt(p.f, b), 0); // already applied ahead of the bands
    const gain = Math.round(clamp(0.8 * (r - refMid - (o - ownMid) - profile), -9, 9));
    if (gain) eq[p.id] = gain;
  }
  state.eq = eq;
  state.custom = { v: { ...state.v }, eq: { ...eq } };
  state.preset = 'custom';
  renderPreset();
  reportToTray();
  renderSliders(true);
  showEqTab('freq');
  applyAll();
  save();
  flash('Частоты подогнаны под образец — пресет «Свой»', false, 6000);
});

/* ───────── Recordings: files and takes ───────── */
const filesNote = $('#filesNote');
async function sendMono(token, mono) {
  const step = 48000 * 30;
  for (let at = 0; at < mono.length; at += step) {
    if (!(await window.auraSystem.renderChunk(token, mono.slice(at, at + step).buffer))) return false;
  }
  return true;
}
let fileBusy = false;
async function processFile(file) {
  if (fileBusy || !file) return;
  if (!(await window.auraSystem.renderAvailable())) return (filesNote.textContent = 'Обработчик файлов не найден — переустановите Aura.');
  fileBusy = true;
  filesNote.className = 'footnote';
  try {
    filesNote.textContent = `Читаю «${file.name}»…`;
    const mono = await decodeMono(file);
    const token = await window.auraSystem.renderBegin(file.name);
    if (!token) return (filesNote.textContent = '');
    filesNote.textContent = `Обрабатываю ${Math.round(mono.length / 48000)} с звука тем же звуком, что в эфире…`;
    const res = (await sendMono(token, mono)) ? await window.auraSystem.renderFinish(token, systemLines(true, false)) : { ok: false };
    filesNote.textContent = res.ok ? `Готово: «${res.name}», ${Math.round(res.seconds)} с.` : 'Не получилось обработать этот файл.';
    if (!res.ok) filesNote.className = 'footnote warn';
  } catch {
    filesNote.textContent = 'Не получилось прочитать этот файл. Подойдут mp3, wav, m4a, ogg, flac, mp4, webm.';
    filesNote.className = 'footnote warn';
  } finally {
    fileBusy = false;
  }
}
const drop = $('#fileDrop');
$('#filePick').addEventListener('click', async () => processFile(await pickFile('audio/*,video/*')));
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => processFile(e.dataTransfer?.files?.[0]));
addEventListener('dragover', (e) => e.preventDefault()); // a file dropped beside the zone must not navigate the window away
addEventListener('drop', (e) => e.preventDefault());

// A take: what the microphone gives right now. With the module installed that is already the
// processed voice; without it, the take goes through the renderer like any other file.
const takeBtn = $('#takeBtn');
let take = null;
takeBtn.addEventListener('click', async () => {
  if (take) return take.rec.stop();
  if (!engine.running || !engine.stream) return (filesNote.textContent = 'Сначала включите сферу: дубль пишется с включённого микрофона.');
  const rec = new MediaRecorder(engine.stream);
  const chunks = [];
  const started = performance.now();
  take = { rec, timer: setInterval(() => (takeBtn.textContent = `Остановить · ${Math.floor((performance.now() - started) / 1000)} с`), 250) };
  takeBtn.classList.add('live');
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    clearInterval(take.timer);
    take = null;
    takeBtn.classList.remove('live');
    takeBtn.textContent = 'Записать дубль';
    try {
      const mono = await decodeMono(new Blob(chunks, { type: rec.mimeType }));
      const token = await window.auraSystem.renderBegin('Дубль');
      if (!token) return;
      const res = (await sendMono(token, mono)) ? await window.auraSystem.renderFinish(token, sys.installed ? null : systemLines(true, false)) : { ok: false };
      filesNote.className = res.ok ? 'footnote' : 'footnote warn';
      filesNote.textContent = res.ok ? `Дубль сохранён: «${res.name}», ${Math.round(res.seconds)} с.` : 'Не получилось сохранить дубль.';
    } catch {
      filesNote.className = 'footnote warn';
      filesNote.textContent = 'Не получилось сохранить дубль.';
    }
  };
  rec.start();
});

/* ───────── AI voices ─────────
 * Neural voice conversion with models the user adds. Off line for now: a recording goes in,
 * the same words in another voice come out. */
const aiNote = (text, warn = false) => {
  $('#aiNote').textContent = text;
  $('#aiNote').className = warn ? 'footnote warn' : 'footnote';
};
let aiBusy = false;
let aiLiveOn = false; // this session only: the live voice never starts by itself
const AI_LIVE_IDLE = $('#aiLiveText').textContent;
async function setAiLive(on) {
  const box = $('#aiLive');
  if (on) {
    if (!sys.installed) { box.checked = false; return aiNote('Живой режим работает через модуль в микрофоне: встройте его в Настройках.', true); }
    if (!engine.running) { box.checked = false; return aiNote('Сначала включите сферу.', true); }
    aiNote('Загружаю нейросеть…');
    const res = await window.auraSystem.aiLive(true, state.aiVoice, state.aiPitch || 0, state.aiSpeaker || 0);
    if (res.error) { box.checked = false; return aiNote(res.error, true); }
    aiNote('В эфире выбранный голос. Собеседники слышат вас с опозданием около полсекунды.');
  } else {
    await window.auraSystem.aiLive(false);
    $('#aiLiveText').textContent = AI_LIVE_IDLE;
    aiNote('');
  }
  aiLiveOn = on;
  box.checked = on;
  pushSystem();
}
$('#aiLive').addEventListener('change', (e) => setAiLive(e.target.checked));
// How the conversion is keeping up, while it runs.
setInterval(async () => {
  if (!aiLiveOn) return;
  const s = await window.auraSystem.aiStatus();
  if (!s.live?.on) { // the worker stopped: the module falls back to the ordinary voice by itself
    aiLiveOn = false;
    $('#aiLive').checked = false;
    pushSystem();
    return aiNote(s.live?.error ? `Живой режим остановился: ${s.live.error}` : 'Живой режим остановился.', true);
  }
  if (s.live.ms) $('#aiLiveText').textContent = `В эфире. На каждые 240 мс звука уходит ${s.live.ms} мс расчёта (в худшем случае ${s.live.worst})${s.live.late ? `; не успел ${s.live.late} раз — звук прерывался` : ''}.`;
}, 1500);
async function renderAi() {
  const s = await window.auraSystem.aiStatus();
  $('#aiEngineTitle').textContent = s.encoder ? 'Нейросеть готова' : 'Нужен компонент для ИИ-голосов';
  $('#aiEngineText').textContent = s.encoder
    ? 'Преобразование идёт на вашем компьютере, на видеокарте, если она есть. Ничего никуда не отправляется.'
    : s.downloading != null
      ? `Скачиваю… ${Math.round(s.downloading * 100)} %`
      : `Модель, которая понимает, что сказано в записи. ${s.megabytes} МБ, скачивается один раз с huggingface.co.`;
  const get = $('#aiGet');
  get.hidden = s.encoder;
  get.disabled = s.downloading != null;
  get.textContent = s.downloading != null ? 'Скачиваю…' : `Скачать, ${s.megabytes} МБ`;
  if (state.aiVoice === 'base' ? !s.base.present : !s.voices.some((v) => v.id === state.aiVoice)) state.aiVoice = s.base.present ? 'base' : s.voices[0]?.id || '';
  // The open voices come first: one free model, 109 timbres.
  const open = document.createElement('label');
  open.className = 'ai-voice';
  const openName = document.createElement('b');
  openName.textContent = 'Открытые голоса';
  const openKind = document.createElement('small');
  if (s.base.present) {
    const pick = document.createElement('input');
    pick.type = 'radio';
    pick.name = 'aiVoice';
    pick.checked = state.aiVoice === 'base';
    pick.addEventListener('change', () => { state.aiVoice = 'base'; save(); renderAi(); });
    const num = document.createElement('input');
    num.type = 'number';
    num.min = 0;
    num.max = s.base.speakers - 1;
    num.value = state.aiSpeaker;
    num.className = 'ai-speaker';
    num.setAttribute('aria-label', 'Номер тембра');
    num.addEventListener('change', () => { state.aiSpeaker = clamp(Math.round(Number(num.value) || 0), 0, s.base.speakers - 1); num.value = state.aiSpeaker; state.aiVoice = 'base'; save(); if (aiLiveOn) window.auraSystem.aiLiveSet(state.aiPitch || 0, state.aiSpeaker); });
    openKind.textContent = `тембр № из ${s.base.speakers}`;
    open.append(pick, openName, openKind, num);
  } else {
    const get = document.createElement('button');
    get.type = 'button';
    get.className = 'pill small';
    get.disabled = s.base.downloading != null;
    get.textContent = s.base.downloading != null ? `Скачиваю… ${Math.round(s.base.downloading * 100)} %` : `Скачать, ${s.base.megabytes} МБ`;
    get.addEventListener('click', async (e) => {
      e.preventDefault();
      const done = window.auraSystem.aiBase();
      setTimeout(renderAi, 300);
      if (!(await done)) aiNote('Не получилось скачать открытые голоса. Проверьте интернет и попробуйте ещё раз.', true);
      renderAi();
    });
    openKind.textContent = `${s.base.speakers} тембров, бесплатно`;
    open.append(openName, openKind, get);
  }
  const list = $('#aiVoices');
  list.replaceChildren(
    open,
    ...(s.voices.length
      ? s.voices.map((v) => {
          const row = document.createElement('label');
          row.className = 'ai-voice';
          const pick = document.createElement('input');
          pick.type = 'radio';
          pick.name = 'aiVoice';
          pick.checked = v.id === state.aiVoice;
          pick.addEventListener('change', () => { state.aiVoice = v.id; save(); });
          const name = document.createElement('b');
          name.textContent = v.name;
          const kind = document.createElement('small');
          kind.textContent = v.pitched ? 'с высотой' : 'без высоты';
          const del = document.createElement('button');
          del.type = 'button';
          del.className = 'link';
          del.textContent = 'Убрать';
          del.addEventListener('click', async (e) => { e.preventDefault(); await window.auraSystem.aiRemove(v.id); renderAi(); });
          row.append(pick, name, kind, del);
          return row;
        })
      : [Object.assign(document.createElement('p'), { className: 'ai-empty', textContent: 'Свои голоса: файл модели RVC второго поколения — .pth (как их обычно выкладывают; aura.txt сама переведёт его в нужный вид, не запуская ничего из файла) или .onnx. Файл .index не нужен.' })])
  );
  for (const id of ['aiTry', 'aiFile']) $('#' + id).disabled = aiBusy || !s.encoder || !state.aiVoice;
  $('#aiLive').disabled = (!s.encoder || !state.aiVoice) && !aiLiveOn;
  if (s.downloading != null || s.base.downloading != null) setTimeout(renderAi, 700);
}
$('#aiGet').addEventListener('click', async () => {
  const done = window.auraSystem.aiDownload();
  setTimeout(renderAi, 300);
  if (!(await done)) aiNote('Не получилось скачать компонент. Проверьте интернет и попробуйте ещё раз.', true);
  renderAi();
});
$('#aiAdd').addEventListener('click', async () => {
  const res = await window.auraSystem.aiAdd();
  if (res?.error) aiNote(res.error, true);
  else if (res?.ok) aiNote('Голос добавлен.');
  renderAi();
});
$('#aiPitch').value = state.aiPitch || 0;
fill($('#aiPitch'));
$('#aiPitchVal').textContent = (state.aiPitch > 0 ? '+' : '') + (state.aiPitch || 0);
$('#aiPitch').addEventListener('input', (e) => {
  state.aiPitch = Number(e.target.value);
  $('#aiPitchVal').textContent = (state.aiPitch > 0 ? '+' : '') + state.aiPitch;
  fill(e.target);
  save();
  if (aiLiveOn) window.auraSystem.aiLiveSet(state.aiPitch, state.aiSpeaker || 0);
});
// The neural voice sits on top of the cleaning part of the voice settings, as it does live: the
// recording first goes through the microphone's chain with tone shaping left out (see
// systemLines), and what comes out of that is what the network hears.
async function throughVoiceSettings(mono) {
  if (!(await window.auraSystem.renderAvailable())) return mono;
  const out = await window.auraSystem.renderSample(mono.slice().buffer, systemLines(true, false, true));
  if (!out) return mono;
  const stereo = new Float32Array(out);
  const voice = new Float32Array(stereo.length >> 1);
  for (let i = 0; i < voice.length; i++) voice[i] = 0.5 * (stereo[2 * i] + stereo[2 * i + 1]);
  return voice;
}
async function aiRun(mono, label) {
  aiBusy = true;
  renderAi();
  const tick = setInterval(async () => {
    const s = await window.auraSystem.aiStatus();
    if (s.converting != null) aiNote(`${label}… ${Math.round(s.converting * 100)} %`);
  }, 500);
  aiNote(`${label}…`);
  const res = await window.auraSystem.aiConvert((await throughVoiceSettings(mono)).slice().buffer, state.aiVoice, state.aiPitch || 0, state.aiSpeaker || 0);
  clearInterval(tick);
  aiBusy = false;
  renderAi();
  if (res.error) return aiNote(`Не получилось: ${res.error}`, true), null;
  return new Float32Array(res.pcm);
}
$('#aiTry').addEventListener('click', async () => {
  if (!engine.running) return aiNote('Сначала включите сферу: запись играет через неё.', true);
  if (engine.sampleMode) {
    engine.stopSample();
    sampleRaw = sampleRendered = null;
    syncBypass();
    pushSystem();
    renderSample();
    $('#aiTry').textContent = 'Послушать этим голосом';
    return aiNote('');
  }
  const stored = await window.auraSystem.loadTake();
  if (!stored) return aiNote('Записи ещё нет. Нажмите «Автонастройку» или «Записать пробу» — и вернитесь сюда.', true);
  const out = await aiRun(new Float32Array(stored), 'Преобразую вашу запись');
  if (!out) return;
  engine.playBuffer(toBuffer(out, 1));
  syncBypass();
  renderSample();
  $('#aiTry').textContent = 'Остановить';
  aiNote('Играет ваша запись выбранным голосом.');
});
$('#aiFile').addEventListener('click', async () => {
  const file = await pickFile('audio/*,video/*');
  if (!file) return;
  let mono;
  try {
    aiNote(`Читаю «${file.name}»…`);
    mono = await decodeMono(file, 600);
  } catch {
    return aiNote('Не получилось прочитать этот файл. Подойдут mp3, wav, m4a, ogg, flac, mp4, webm.', true);
  }
  const out = await aiRun(mono, `Преобразую ${Math.round(mono.length / 48000)} с звука`);
  if (!out) return;
  const token = await window.auraSystem.renderBegin(file.name);
  if (!token) return aiNote('');
  const res = (await sendMono(token, out)) ? await window.auraSystem.renderFinish(token, null) : { ok: false };
  aiNote(res.ok ? `Готово: «${res.name}», ${Math.round(res.seconds)} с.` : 'Не получилось сохранить файл.', !res.ok);
});

/* ───────── Start with Windows ───────── */
// Переключить можно и в меню значка: тогда main.js присылает «autostart», и галочка здесь, и пункт в core.txt
// («Общие» → «Запуск и обновления») берут настоящее состояние, а не то, что было при открытии окна
function readAutostart(publish) {
  window.auraSystem?.getAutostart?.().then((on) => {
    $('#autostart').checked = !!on;
    if (publish) publishHubSettings();
  }, () => {});
}
readAutostart(false);
window.auraSystem?.onCommand?.((name) => {
  if (name === 'autostart') readAutostart(true);
});
$('#autostart').addEventListener('change', async (e) => {
  e.target.checked = !!(await window.auraSystem.setAutostart(e.target.checked));
});

/* ───────── Updates ───────── */
const updateBtn = $('#updateBtn');
async function checkUpdate() {
  if (!state.autoUpdate || TEST || !window.auraSystem?.checkUpdate) return;
  const u = await window.auraSystem.checkUpdate();
  updateBtn.hidden = !u;
  if (u) updateBtn.textContent = `Обновить до ${u.version}`;
}
updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true;
  updateBtn.textContent = 'Скачиваю обновление…';
  if (!(await window.auraSystem.installUpdate())) { // on success the app closes and the installer takes over
    updateBtn.disabled = false;
    updateBtn.textContent = 'Не скачалось — попробовать ещё раз';
  }
});
$('#autoUpdate').checked = state.autoUpdate !== false;
$('#autoUpdate').addEventListener('change', (e) => {
  state.autoUpdate = e.target.checked;
  save();
  if (state.autoUpdate) checkUpdate();
  else updateBtn.hidden = true;
});

/* ───────── Output loudness and hum ───────── */
const loudSelect = $('#loudTarget');
loudSelect.value = String(state.loud || 0);
loudSelect.addEventListener('change', () => {
  state.loud = Number(loudSelect.value) || 0;
  applyAll();
  save();
});
$('#dehum').checked = !!state.dehum;
$('#dehum').addEventListener('change', (e) => {
  state.dehum = e.target.checked;
  applyAll();
  save();
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
  drawSpectrum(now);
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
  renderFit();
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
  checkUpdate();
  setInterval(pollSystem, 2000);
  startHubSettings();
  window.auraSystem?.onCommand((name, arg) => {
    if (name === 'visible') setWindowVisible(!!arg);
    if (name === 'power') setPower(!engine.running);
    if (name === 'preset') selectPreset(arg);
    if (name === 'voice') selectVoice(arg === state.fx ? 'none' : arg); // the same key again switches it off
    if (name === 'pad' && state.pads[arg]) playPad(state.pads[arg]);
    if (name === 'page') openPage(arg);
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

/* ───── Запуск, обновления и дорога к core.txt ─────
 * Своя группа внизу «Настроек». Без core.txt — переключатели запуска и обновлений и тихая строка «Скачать core.txt».
 * Когда core.txt установлен, запуск вместе с Windows и обновления настраиваются в нём (пункты с section: "startup"
 * в aura.settings): их строки здесь прячутся, вместо них — «Настраивается в core.txt» с кнопкой на его страницу
 * «Общие». Ключи и значения те же — меняется только место, где их видно. Пока значок aura.txt у core.txt, своего
 * меню с «Выход» нет, а в меню core.txt выхода для приложений нет: тогда здесь же строка «Выйти из aura.txt». */
(function startupGroup() {
  const row = document.getElementById('coreRow'), btn = document.getElementById('coreBtn'), title = document.getElementById('coreTitle'), hint = document.getElementById('coreHint');
  const quitRow = document.getElementById('quitRow'), quitBtn = document.getElementById('quitBtn');
  const sys = window.auraSystem;
  if (!row || !btn || !title || !sys?.coreInfo) return;
  const startupRows = ['autostart', 'autoUpdate'].map((id) => document.getElementById(id)?.closest('label')).filter(Boolean);
  let installed = false;
  async function paint() {
    const info = await sys.coreInfo().catch(() => null);
    if (!info) return;
    installed = !!info.installed;
    const here = info.online || installed;
    for (const r of startupRows) r.hidden = installed;
    title.textContent = installed ? 'Настраивается в core.txt' : 'core.txt — лаунчер dev.txt';
    btn.textContent = here ? 'Открыть core.txt' : 'Скачать core.txt';
    btn.classList.toggle('prominent', !here);
    hint.textContent = installed
      ? 'На странице «Общие», рядом с остальными приложениями dev.txt'
      : here
        ? 'Обновления, общие настройки и остальные приложения dev.txt — в одном окне'
        : 'Все приложения dev.txt в одном окне: установка, обновления и общие настройки. aura.txt работает и без него';
    row.hidden = false;
    if (quitRow) quitRow.hidden = !info.quitHere || !sys.quit;
  }
  // Установлен — сразу на «Общие» (core.txt запущен — просьбой через хаб, нет — запуском с этой страницей), нет — скачать
  btn.addEventListener('click', async () => { await sys.coreGo(installed ? 'general' : undefined).catch(() => {}); setTimeout(paint, 1500); });
  quitBtn?.addEventListener('click', () => sys.quit?.());
  // Значок ушёл к core.txt или вернулся, core.txt появился или пропал — main.js присылает «family»
  sys.onCommand?.((name) => {
    if (name === 'family') paint();
  });
  window.addEventListener('focus', paint);
  paint();
})();

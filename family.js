// family.js — aura.txt в семье dev.txt™ поверх хаба: один значок в трее у core.txt, быстрые действия и горячие клавиши
// для его страниц, уведомления на острове kapsula.txt. Что и зачем — в kit.txt, hub/PROTOCOL.md, раздел «Семья»;
// здесь то же, что hub/Family.cs делает для приложений на C#. Electron не нужен: проверяется обычным node
// (scripts/family-test.js).
//
//   const family = new Family('aura', () => …);          // core.family или hub.apps поменялись, связь пропала
//   const hub = connect(family.wrap({ app: 'aura', topics, commands, onState }));
//   family.attach(hub);
//   family.setTray(auraTray(ui, { show, power, mute }));
//   if (!family.notify('aura.txt', 'Текст', true)) своёУведомление();
'use strict';

const TOPIC = 'core.family';
const TRAY_RUN = 'tray.run';
const NOTIFY = 'notify';
const FOCUS_SET = 'focus.set';
const MAX_TRAY = 4;
const MAX_KEYS = 64;

// ───────── core.family: что сейчас у всех ─────────

// Состояние от core.txt; null — пришло не то (или core.txt сказал, что состояния больше нет)
function familyState(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const until = data.focusUntil;
  return {
    tray: data.tray === true, // значок в трее у семьи один — у core.txt; свои приложения прячут
    focus: data.focus === true, // «Не беспокоить» для всех
    focusUntil: typeof until === 'number' && Number.isFinite(until) && until > 0 ? Math.trunc(until) : 0, // мс с 1970 года (UTC); 0 — пока не выключат
    game: data.game === true, // впереди игра или другое окно на весь экран
    gameApp: typeof data.gameApp === 'string' ? data.gameApp : '', // имя процесса этого окна без .exe
  };
}

// Когда «Не беспокоить» кончится; null — выключено или пока не выключат
function focusEnds(state) {
  return state && state.focus && state.focusUntil > 0 ? new Date(state.focusUntil) : null;
}

// Кто подключён к хабу и что умеет: hub.apps → Map(приложение → Set(команды))
function appsFrom(data) {
  const apps = new Map();
  if (!Array.isArray(data)) return apps;
  for (const a of data) {
    if (!a || typeof a !== 'object' || typeof a.app !== 'string') continue;
    apps.set(a.app, new Set(Array.isArray(a.commands) ? a.commands.filter((c) => typeof c === 'string') : []));
  }
  return apps;
}

// Обрезка как в Family.cs: пробелы по краям прочь, длиннее max — многоточие
function cut(text, max) {
  const s = String(text == null ? '' : text).trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// ───────── Сочетания клавиш одной строкой (KeyNames.Normal из Family.cs) ─────────

const KEY_ALIASES = new Map(Object.entries({
  ctrl: 'Ctrl', control: 'Ctrl', ctl: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl',
  alt: 'Alt', option: 'Alt', menu: 'Alt', altgr: 'Alt',
  shift: 'Shift',
  win: 'Win', windows: 'Win', meta: 'Win', super: 'Win', cmd: 'Win', command: 'Win', lwin: 'Win', rwin: 'Win',
  esc: 'Esc', escape: 'Esc', return: 'Enter', enter: 'Enter', space: 'Space', spacebar: 'Space',
  tab: 'Tab', backspace: 'Backspace', del: 'Delete', delete: 'Delete', ins: 'Insert', insert: 'Insert',
  home: 'Home', end: 'End', pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  prtsc: 'PrintScreen', printscreen: 'PrintScreen', print: 'PrintScreen', pause: 'Pause', capslock: 'CapsLock',
  backquote: '`', grave: '`', '~': '`', plus: '=',
  mediaplaypause: 'PlayPause', playpause: 'PlayPause', medianexttrack: 'NextTrack', nexttrack: 'NextTrack',
  mediaprevioustrack: 'PrevTrack', prevtrack: 'PrevTrack', volumemute: 'Mute', mute: 'Mute',
  volumeup: 'VolumeUp', volumedown: 'VolumeDown',
}));

// Одна запись для сравнения: Ctrl, Alt, Shift, Win в этом порядке, потом клавиша — «Ctrl+Alt+S».
// Регистр, пробелы и порядок модификаторов не важны («alt + ctrl+s» → «Ctrl+Alt+S»); пустая строка — сочетания нет.
function normalKeys(keys) {
  if (typeof keys !== 'string' || !keys) return '';
  let ctrl = false, alt = false, shift = false, win = false, key = null;
  let text = keys.trim();
  // «Ctrl++» — плюс сам по себе клавиша
  if (text.endsWith('++')) {
    key = '=';
    text = text.slice(0, -2);
  }
  for (const raw of text.split('+')) {
    const p = raw.trim();
    if (!p) continue;
    let a = KEY_ALIASES.get(p.toLowerCase());
    if (a === undefined) a = p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1);
    if (a === 'Ctrl') ctrl = true;
    else if (a === 'Alt') alt = true;
    else if (a === 'Shift') shift = true;
    else if (a === 'Win') win = true;
    else key = a;
  }
  const parts = [];
  if (ctrl) parts.push('Ctrl');
  if (alt) parts.push('Alt');
  if (shift) parts.push('Shift');
  if (win) parts.push('Win');
  if (key !== null) parts.push(key);
  return parts.join('+');
}

// ───────── aura.txt: что она вешает на клавиши и что даёт в общий трей ─────────

// Сочетание, которое aura.txt умеет занять (в записи Electron): до трёх Ctrl, Alt, Shift и клавиша
const accelOk = (a) => typeof a === 'string' && /^((Ctrl|Alt|Shift)\+){0,3}([A-Z0-9]|F\d{1,2}|num\d|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert)$/.test(a);

// Что занимается и в каком порядке: одно сочетание — одно действие, кто раньше, того и клавиша.
// config — то, что прислало окно: { power, mute, voices: [[голос, сочетание]], pads: [сочетание | null], padNames }
function hotkeyPlan(config) {
  const c = config && typeof config === 'object' ? config : {};
  const plan = [];
  const used = new Set();
  const add = (id, accel, action, arg) => {
    if (!accelOk(accel) || used.has(accel)) return;
    used.add(accel);
    plan.push({ id, accel, action, arg });
  };
  add('power', c.power, 'power');
  add('mute', c.mute, 'mute');
  // Готовые голоса со своей клавишей; та же клавиша ещё раз возвращает обычный голос
  for (const entry of Array.isArray(c.voices) ? c.voices.slice(0, 40) : []) {
    if (!Array.isArray(entry)) continue;
    const [id, accel] = entry;
    if (typeof id === 'string' && /^[a-z]{2,20}$/.test(id)) add('voice.' + id, accel, 'voice', id);
  }
  const pads = Array.isArray(c.pads) ? c.pads.slice(0, 200) : [];
  pads.forEach((key, i) => key && add('pad.' + i, key, 'pad', i));
  // Звуки без своей клавиши: первые девять — Ctrl+Alt+цифра
  pads.forEach((key, i) => !key && i < 9 && add('pad.' + i, `Ctrl+Alt+${i + 1}`, 'pad', i));
  return plan;
}

// aura.keys для страницы «Клавиши» в core.txt. Обработка и микрофон — всегда (без сочетания — выключены),
// голоса и звуки — те, что заняли клавишу. Занятая другой программой остаётся on: core.txt покажет, с чем она совпала.
// names.voices — Map(голос → название) из окна
function auraKeys(config, names) {
  const c = config && typeof config === 'object' ? config : {};
  const plan = hotkeyPlan(c);
  const bound = new Set(plan.map((k) => k.id));
  const voiceName = (id) => (names && names.voices && typeof names.voices.get === 'function' && names.voices.get(id)) || id;
  const padNames = Array.isArray(c.padNames) ? c.padNames : [];
  const padLabel = (i) => {
    const name = typeof padNames[i] === 'string' ? cut(padNames[i], 40) : '';
    return name ? `Звук «${name}»` : `Звук ${i + 1}`;
  };
  const keys = [
    { id: 'power', label: 'Обработка голоса', keys: accelOk(c.power) ? normalKeys(c.power) : '', on: bound.has('power') },
    { id: 'mute', label: 'Заглушить микрофон', keys: accelOk(c.mute) ? normalKeys(c.mute) : '', on: bound.has('mute') },
  ];
  for (const k of plan) if (k.action === 'voice') keys.push({ id: k.id, label: `Эффект «${voiceName(k.arg)}»`, keys: normalKeys(k.accel), on: true });
  const pads = plan.filter((k) => k.action === 'pad').sort((a, b) => a.arg - b.arg); // по порядку звуков, а не занятия клавиш
  for (const k of pads) keys.push({ id: k.id, label: padLabel(k.arg), keys: normalKeys(k.accel), on: true });
  return keys.slice(0, MAX_KEYS);
}

// Быстрые действия aura.txt в общем трее core.txt — первые пункты её собственного меню.
// ui — что окно сообщило последним; actions — что делать по каждому пункту
function auraTray(ui, actions) {
  const a = actions || {};
  return [
    { key: 'show', label: 'Открыть', run: a.show },
    { key: 'power', label: 'Обработка голоса', check: !!(ui && ui.on), run: a.power },
    { key: 'mute', label: 'Заглушить микрофон', check: !!(ui && ui.mute), enabled: !!(ui && ui.system), run: a.mute }, // глушить умеет только модуль в микрофоне
  ];
}

// Пункт меню так, как его видит core.txt: { key, label, check?, enabled? }
function trayItemData(t) {
  const d = { key: String(t.key), label: String(t.label) };
  if (typeof t.check === 'boolean') d.check = t.check;
  if (t.enabled === false) d.enabled = false;
  return d;
}

// ───────── Связь с семьёй ─────────
// Слушает core.family и hub.apps, отвечает на tray.run, отдаёт <app>.tray и <app>.keys (одно и то же второй раз не шлёт)
class Family {
  constructor(app, onChange) {
    this.app = app;
    this.onChange = onChange || null; // core.family или hub.apps поменялись, связь пропала
    this.hub = null;
    this.core = null; // что последним сказал core.txt; null — его нет на связи
    this.apps = new Map(); // кто подключён → что умеет
    this.tray = []; // пункты, которые сейчас в меню core.txt
    this.sent = { tray: null, keys: null }; // что ушло последним
    this.last = { tray: null, keys: null }; // что отдать хабу, когда он появится
  }

  // Подмешивает в настройки connect() из hub-client.js свои темы, команду tray.run и обработчики
  wrap(options) {
    const own = options || {};
    const o = Object.assign({}, own);
    o.topics = (own.topics || []).slice();
    for (const t of [TOPIC, 'hub.apps']) if (!o.topics.includes(t)) o.topics.push(t);
    o.commands = Object.assign({}, own.commands, { [TRAY_RUN]: (args) => this.runTray(args) });
    o.onState = (topic, data, from) => {
      this.take(topic, data, from);
      if (own.onState) own.onState(topic, data, from);
    };
    o.onStatus = (on) => {
      this.status(on);
      if (own.onStatus) own.onStatus(on);
    };
    return o;
  }

  // Клиент хаба, созданный по wrap(); всё, что успели описать до него, уходит сразу
  attach(hub) {
    this.hub = hub;
    for (const kind of ['tray', 'keys']) if (this.last[kind]) hub.state(this.app + '.' + kind, this.last[kind]);
  }

  take(topic, data, from) {
    if (topic === TOPIC && from === 'core') this.core = familyState(data);
    else if (topic === 'hub.apps' && from === 'hub') this.apps = appsFrom(data);
    else return false;
    this.raise();
    return true;
  }

  status(on) {
    if (on) return; // само подключение ничего не меняет: что скажет core.txt, придёт следом
    this.core = null;
    this.apps = new Map();
    this.raise();
  }

  raise() {
    if (!this.onChange) return;
    try {
      this.onChange();
    } catch {}
  }

  get online() {
    return !!(this.hub && this.hub.online);
  }

  // Что сейчас сообщил core.txt; null — его нет на связи
  get state() {
    return this.online ? this.core : null;
  }

  get coreOnline() {
    return this.state !== null;
  }

  // Свой значок в трее не нужен: core.txt показывает один на всех
  get hideOwnTray() {
    const s = this.state;
    return !!(s && s.tray);
  }

  // «Не беспокоить», включённое в core.txt
  get focus() {
    const s = this.state;
    return !!(s && s.focus);
  }

  // Впереди игра или другое окно на весь экран — по общему правилу core.txt
  get game() {
    const s = this.state;
    return !!(s && s.game);
  }

  // Приложение other подключено и понимает команду command
  has(other, command) {
    if (!this.online) return false;
    const c = this.apps.get(other);
    return !!(c && c.has(command));
  }

  // Остров kapsula.txt на связи и принимает уведомления
  get islandOnline() {
    return this.has('kapsula', NOTIFY);
  }

  // Уведомление на острове. false — острова нет: покажите своё, как раньше. open — щелчок по карточке пришлёт show.
  // lost — если остров так и не получил сообщение (отключился, не знает команды): тогда своё всё-таки нужно
  notify(title, text, open, lost) {
    if (!this.islandOnline) return false;
    const args = { title: cut(title, 60), text: cut(text, 200) };
    if (open) args.open = true;
    Promise.resolve(this.hub.command('kapsula', NOTIFY, args)).then(
      (r) => {
        if (lost && r && !r.ok && (r.error === 'offline' || r.error === 'unknown-command')) lost();
      },
      () => {}
    );
    return true;
  }

  // «Не беспокоить» для всех. minutes <= 0 — пока не выключат. false — core.txt нет.
  setFocus(on, minutes) {
    if (!this.has('core', FOCUS_SET)) return false;
    const args = { on: !!on };
    if (on && minutes > 0) args.minutes = minutes;
    this.hub.command('core', FOCUS_SET, args);
    return true;
  }

  // Быстрые действия для общего меню в трее (не больше четырёх): { key, label, check?, enabled?, run }
  setTray(items) {
    this.tray = (Array.isArray(items) ? items : []).filter((t) => t && t.key && t.label).slice(0, MAX_TRAY);
    return this.publish('tray', { items: this.tray.map(trayItemData) });
  }

  // Горячие клавиши для страницы «Клавиши» в core.txt: { id, label, keys, on }
  setKeys(keys) {
    const list = (Array.isArray(keys) ? keys : []).filter(Boolean).slice(0, MAX_KEYS);
    return this.publish('keys', { keys: list.map((k) => ({ id: String(k.id || ''), label: String(k.label || ''), keys: String(k.keys || ''), on: k.on !== false })) });
  }

  publish(kind, data) {
    const text = JSON.stringify(data);
    if (text === this.sent[kind]) return false;
    this.sent[kind] = text;
    this.last[kind] = data;
    if (this.hub) this.hub.state(this.app + '.' + kind, data);
    return true;
  }

  // Команда tray.run { key } от core.txt
  runTray(args) {
    const key = args && typeof args.key === 'string' ? args.key : null;
    const item = this.tray.find((t) => t.key === key);
    if (!item) throw new Error('такого пункта нет');
    if (item.enabled === false) throw new Error('пункт сейчас недоступен');
    if (typeof item.run === 'function') item.run();
    return null;
  }
}

// ───────── Свой значок в трее: когда он есть ─────────
// Пока core.txt держит один значок на всех (core.family.tray) и связь есть — своего нет. Связь пропала или core.txt
// отдал значок — свой появляется сразу. Убирается не сразу, а когда core.txt держит его hideDelay подряд, чтобы
// мигающая связь не мигала и значком; если значок только что возвращался, ждём дольше. При запуске, когда core.txt
// установлен, свой значок можно придержать до waitMs, пока core.txt не ответит, — но не дольше: без входа не остаёмся.
class TrayGate {
  // apply(true) — создать свой значок, apply(false) — убрать. timers — для проверок: { set, clear, now }
  constructor(apply, options) {
    const o = options || {};
    this.apply = apply;
    this.hideDelay = o.hideDelay != null ? o.hideDelay : 1500;
    this.slowHideDelay = o.slowHideDelay != null ? o.slowHideDelay : 8000;
    this.flapWindow = o.flapWindow != null ? o.flapWindow : 60000;
    this.timers = o.timers || { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t), now: () => Date.now() };
    this.shown = false; // свой значок сейчас есть
    this.hide = false; // core.txt держит значок
    this.started = false;
    this.stopped = false;
    this.answered = false; // core.txt уже ответил (тогда при start() ждать его незачем)
    this.waitUntil = 0; // до этого времени ждём core.txt, прежде чем показать свой
    this.held = false; // core.txt держал значок с тех пор, как свой появлялся последний раз
    this.backAt = -Infinity; // когда свой значок последний раз вернулся после core.txt
    this.hideTimer = null;
    this.waitTimer = null;
  }

  start(waitMs) {
    if (this.started || this.stopped) return;
    this.started = true;
    this.waitUntil = waitMs > 0 && !this.answered ? this.timers.now() + waitMs : 0;
    this.run();
  }

  // hide — core.txt держит значок; known — core.txt вообще что-то сказал (тогда ждать его больше незачем)
  set(hide, known) {
    this.hide = !!hide;
    if (known || hide) {
      this.answered = true;
      this.waitUntil = 0;
    }
    if (this.started && !this.stopped) this.run();
  }

  // Приложение закрывается: значок больше не трогаем
  stop() {
    this.stopped = true;
    this.clear('hideTimer');
    this.clear('waitTimer');
  }

  clear(name) {
    if (this[name] === null) return;
    this.timers.clear(this[name]);
    this[name] = null;
  }

  put(show) {
    this.shown = show;
    try {
      this.apply(show);
    } catch {}
  }

  run() {
    const now = this.timers.now();
    if (this.hide) {
      this.held = true;
      this.waitUntil = 0; // core.txt ответил: ждать его больше незачем
      this.clear('waitTimer');
      if (this.shown && this.hideTimer === null) {
        const delay = now - this.backAt < this.flapWindow ? this.slowHideDelay : this.hideDelay;
        this.hideTimer = this.timers.set(() => {
          this.hideTimer = null;
          if (!this.stopped && this.hide && this.shown) this.put(false);
        }, delay);
      }
      return;
    }
    this.clear('hideTimer');
    if (this.shown) return;
    if (this.waitUntil > now) {
      if (this.waitTimer === null) {
        this.waitTimer = this.timers.set(() => {
          this.waitTimer = null;
          this.waitUntil = 0;
          if (!this.stopped) this.run();
        }, this.waitUntil - now);
      }
      return;
    }
    this.clear('waitTimer');
    if (this.held) {
      this.backAt = now;
      this.held = false;
    }
    this.put(true);
  }
}

module.exports = {
  TOPIC, TRAY_RUN, NOTIFY, FOCUS_SET, MAX_TRAY, MAX_KEYS,
  familyState, focusEnds, appsFrom, cut, normalKeys, accelOk, hotkeyPlan, auraKeys, auraTray, trayItemData,
  Family, TrayGate,
};

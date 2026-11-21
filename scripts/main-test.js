// Проверка проводки main.js без Electron: main.js грузится обычным node с поддельным модулем electron и поддельным
// child_process — ни настоящего значка, окна, сочетаний клавиш, уведомлений, реестра, ни запуска программ. Связь —
// с образцовым хабом kit.txt на свободном порту (не 42080 настоящего core.txt). Папки данных временные: настоящие
// настройки aura.txt и модуля в микрофоне (%ProgramData%\Aura) не трогаются.
//   node scripts/main-test.js --hub <kit.txt>/hub/hub.js                  все случаи, каждый в своём процессе
//   node scripts/main-test.js --hub <kit.txt>/hub/hub.js --case installed   один: absent | installed | packaged
// Без --hub ищет kit.txt рядом (переменная KIT_HUB, ../kit.txt, ../kit, ../../kit).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');

const repo = path.join(__dirname, '..');
const arg = (name) => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : null;
};
const CASES = ['absent', 'installed', 'packaged'];
const hubJs = [arg('--hub'), process.env.KIT_HUB, '../kit.txt/hub/hub.js', '../kit/hub/hub.js', '../../kit/hub/hub.js']
  .filter(Boolean)
  .map((p) => path.resolve(repo, p))
  .find((p) => fs.existsSync(p));
const only = arg('--case');

if (!hubJs) {
  console.log('не проверялось: нет образцового хаба — укажите --hub <kit.txt>/hub/hub.js');
  process.exit(1);
}
if (!only) {
  // Каждый случай — в своём процессе: main.js держит своё состояние в модуле
  let bad = 0;
  for (const c of CASES) {
    console.log('── ' + c);
    const r = spawnSync(process.execPath, [__filename, '--hub', hubJs, '--case', c], { stdio: 'inherit', timeout: 120000 });
    if (r.status !== 0) bad++;
  }
  console.log(bad ? 'НЕ ПРОШЛО случаев: ' + bad : 'всё прошло · случаев: ' + CASES.length);
  process.exit(bad ? 1 : 0);
}
if (!CASES.includes(only)) {
  console.log('незнакомый случай: ' + only);
  process.exit(1);
}

// ───── Временные папки вместо настоящих ─────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aura-main-test-'));
const userData = path.join(tmp, 'userData');
fs.mkdirSync(userData, { recursive: true });
process.env.LOCALAPPDATA = path.join(tmp, 'local');
process.env.ProgramData = path.join(tmp, 'programdata');
process.resourcesPath = path.join(tmp, 'resources'); // установленная копия берёт модуль отсюда (здесь его нет)
const installed = only !== 'absent';
const packaged = only === 'packaged';
if (installed) {
  fs.mkdirSync(path.join(process.env.LOCALAPPDATA, 'Programs', 'dev.txt'), { recursive: true });
  fs.writeFileSync(path.join(process.env.LOCALAPPDATA, 'Programs', 'dev.txt', 'Core.exe'), ''); // пустой файл: только «установлен»
}
process.argv = [process.argv[0], path.join(repo, 'main.js')]; // main.js читает ключи из argv: без ключей — обычный запуск

let failed = 0, passed = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) passed++;
  else {
    failed++;
    console.log('FAIL ' + name + '\n  получено:  ' + a + '\n  ожидалось: ' + b);
  }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms) => {
  for (let t = 0; t < (ms || 4000); t += 20) {
    if (test()) return true;
    await wait(20);
  }
  return false;
};

// ───── Поддельный Electron ─────
const handles = {}, listeners = {}, appOn = {}, trays = [], balloons = [], toasts = [], wins = [], shortcuts = new Map(), opened = [], spawned = [];
const calls = { quit: 0, aumid: [], login: [], windowAfterAumid: null };
const taken = new Set(['Ctrl+Alt+R']); // будто это сочетание заняла другая программа
let loginOn = false;
class FakeTray {
  constructor(image) { this.image = image; this.destroyed = false; this.on_ = {}; trays.push(this); }
  on(ev, fn) { this.on_[ev] = fn; }
  setImage(i) { this.image = i; }
  setToolTip(t) { this.tip = t; }
  setContextMenu(m) { this.menu = m; }
  displayBalloon(o) { balloons.push(o); }
  destroy() { this.destroyed = true; }
}
class FakeNotification {
  constructor(o) { this.o = o; this.on_ = {}; }
  static isSupported() { return true; }
  on(ev, fn) { this.on_[ev] = fn; }
  show() { toasts.push(this); }
}
class FakeWindow {
  constructor() {
    this.visible = false; this.minimized = false; this.destroyed = false; this.handlers = {}; this.sent = [];
    this.webContents = { send: (...a) => this.sent.push(a), once() {}, on() {}, setZoomFactor() {}, executeJavaScript: async () => null };
    wins.push(this);
    if (calls.windowAfterAumid === null) calls.windowAfterAumid = calls.aumid.length > 0;
  }
  removeMenu() {} setMinimumSize() {} setContentSize() {} loadFile() {}
  once(ev, fn) { if (ev === 'ready-to-show') this.ready = fn; }
  on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  emit(ev, ...args) { for (const fn of this.handlers[ev] || []) fn(...args); }
  isVisible() { return this.visible; } isMinimized() { return this.minimized; }
  show() { this.visible = true; this.emit('show'); } hide() { this.visible = false; this.emit('hide'); }
  focus() {} restore() { this.minimized = false; } isDestroyed() { return this.destroyed; }
}
const electron = {
  app: {
    commandLine: { appendSwitch() {} }, setPath() {}, getPath: () => userData, disableHardwareAcceleration() {},
    requestSingleInstanceLock: () => true, exit() {}, whenReady: () => Promise.resolve(),
    quit() { calls.quit++; if (appOn['before-quit']) appOn['before-quit'](); }, // как в Electron: сначала before-quit
    on(ev, fn) { appOn[ev] = fn; }, getVersion: () => '0.0.0-test', isPackaged: packaged,
    setAppUserModelId(id) { calls.aumid.push(id); },
    getLoginItemSettings: () => ({ openAtLogin: loginOn }),
    setLoginItemSettings(o) { calls.login.push(o); loginOn = !!o.openAtLogin; },
  },
  BrowserWindow: FakeWindow,
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {} } },
  ipcMain: { handle(ch, fn) { handles[ch] = fn; }, on(ch, fn) { listeners[ch] = fn; } },
  Tray: FakeTray,
  Menu: { buildFromTemplate: (t) => t },
  Notification: FakeNotification,
  globalShortcut: { register(a, fn) { shortcuts.set(a, fn); return !taken.has(a); }, unregisterAll() { shortcuts.clear(); } },
  dialog: {}, shell: { openExternal: async (u) => opened.push(u) }, nativeTheme: {},
  net: { fetch: async () => { throw new Error('без сети'); } }, utilityProcess: { fork() { throw new Error('без процессов'); } },
};
const childProcess = {
  execFile(cmd, args, opts, cb) { setImmediate(() => (cb || opts)(new Error('заглушка'), '')); },
  spawn(cmd, args) { spawned.push([path.basename(cmd)].concat(args || [])); return { unref() {} }; },
};
const load = Module._load;
Module._load = function (request, parent) {
  if (request === 'electron') return electron;
  if (request === 'child_process' && parent && path.resolve(parent.filename) === path.resolve(repo, 'main.js')) return childProcess;
  return load.apply(this, arguments);
};

(async () => {
  const server = await require(hubJs).start({ port: 0 });
  if (server.port === 42080) throw new Error('это порт настоящего core.txt');
  process.env.AURA_HUB_PORT = String(server.port);
  const { connect } = require(path.join(repo, 'hub-client.js'));
  const started = Date.now();
  require(path.join(repo, 'main.js'));
  await wait(50); // whenReady: окно, хаб, значок
  const win = wins[0];
  const flag = path.join(userData, 'tray-hint-shown');
  const closeWindow = () => {
    const e = { prevented: false, preventDefault() { this.prevented = true; } };
    win.visible = true;
    win.emit('close', e);
    return e.prevented;
  };
  const sentNames = () => win.sent.filter((s) => s[0] === 'tray:command').map((s) => s.slice(1).filter((x) => x !== undefined && x !== null).join(':'));
  const familyPushes = () => sentNames().filter((x) => x === 'family').length;
  const info = () => handles['core:info'](); // отвечает сразу, без ожидания
  const coreLink = (seen, shows) => connect({
    app: 'core', name: 'core.txt', port: server.port, topics: ['aura.*'],
    commands: { show: (a) => { if (shows) shows.push(a); return null; }, 'focus.set': () => null },
    onState: (t, d) => { if (seen) seen[t] = d; },
  });
  let serverUp = true;
  const stopServer = async () => {
    if (!serverUp) return;
    serverUp = false;
    await server.stop().catch(() => {});
  };
  const finish = async () => {
    await stopServer();
    console.log((failed ? 'НЕ ПРОШЛО: ' + failed : 'всё прошло') + ' · проверок: ' + (passed + failed));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed ? 1 : 0);
  };

  // ───────── core.txt не установлен ─────────
  if (only === 'absent') {
    eq('id ярлыка — только у установленной копии', calls.aumid, []);
    eq('core.txt нет: свой значок сразу', [trays.length, trays[0] && trays[0].destroyed], [1, false]);
    await until(() => info().online, 2000);
    eq('core:info без core.txt', info(), { online: true, installed: false, quitHere: false });
    await wait(2000);
    eq('core.txt нет: значок остаётся', [trays.length, trays[0].destroyed], [1, false]);
    const shows = [];
    const core = coreLink(null, shows); // core.txt, запущенный не из своей папки
    await until(() => core.online);
    core.state('core.family', { tray: true });
    await wait(1200);
    eq('core.txt взял значок: свой ещё есть', trays[0].destroyed, false);
    await until(() => trays[0].destroyed, 1000);
    eq('...и убран через ~1,5 с', trays[0].destroyed, true);
    eq('значок у core.txt: окно узнало, выход — в «Настройках»', [sentNames().slice(-1)[0], info().quitHere], ['family', true]);
    core.state('core.family', { tray: false });
    await until(() => trays.length === 2, 1000);
    eq('core.txt отдал значок: свой сразу', [trays.length, trays[1].destroyed, info().quitHere], [2, false, false]);
    await handles['core:go']({}, 'general');
    eq('core:go: запущенному core.txt — show со страницей', shows.slice(-1), [{ page: 'general' }]);
    core.close();
    await stopServer();
    await until(() => !info().online, 3000);
    await handles['core:go']({}, 'general');
    eq('core:go без core.txt — скачать', [opened.slice(-1)[0], spawned.length], ['https://github.com/cxxperman/core.txt/releases/latest/download/Core.exe', 0]);
    eq('без core.txt своё уведомление Windows не нужно', toasts.length, 0);
    appOn['before-quit']();
    return finish();
  }

  // ───────── установленная копия: id ярлыка, уведомление Windows ─────────
  if (only === 'packaged') {
    const hint = ['aura.txt работает в фоне', 'Голос продолжает обрабатываться. Окно открывается из меню core.txt в трее, а выйти можно в «Настройках».', true];
    eq('id ярлыка — до окна', [calls.aumid, calls.windowAfterAumid], [['app.aura.voice'], true]);
    eq('первый запуск установленной: автозапуск включён', calls.login.slice(0, 1), [{ openAtLogin: true, args: ['--hidden'] }]);
    eq('...и запомнено во временной папке', fs.existsSync(path.join(userData, 'autostart.set')), true);
    const seen = {};
    const core = coreLink(seen);
    await until(() => core.online);
    await until(() => trays.length === 1, 4000); // core.txt на связи, но о значке молчит
    eq('core.txt молчит о значке: свой через ~3 с', trays.length, 1);
    core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    eq('значок уходит к core.txt: окно закрывается', closeWindow(), true);
    eq('подсказка — не у уходящего значка, а уведомлением Windows', [balloons.length, toasts.map((t) => [t.o.title, t.o.body, t.o.silent])], [0, [hint]]);
    eq('...и отмечено', fs.existsSync(flag), true);
    fs.rmSync(flag);
    await until(() => trays[0].destroyed, 2000);
    eq('core:info: значок у core.txt, выход — в «Настройках»', [trays[0].destroyed, info()], [true, { online: true, installed: true, quitHere: true }]);
    core.state('core.family', { tray: true, focus: true, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    eq('«Не беспокоить»: окно закрывается', closeWindow(), true);
    eq('«Не беспокоить»: ни уведомления, ни отметки', [toasts.length, balloons.length, fs.existsSync(flag)], [1, 0, false]);
    core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
    await wait(150);
    closeWindow();
    eq('нет ни острова, ни своего значка: уведомление Windows', [toasts.length, [toasts[1].o.title, toasts[1].o.body, toasts[1].o.silent], fs.existsSync(flag)], [2, hint, true]);
    win.visible = false;
    toasts[1].on_.click();
    eq('щелчок по уведомлению открывает окно', win.visible, true);
    await handles['app:quit']();
    eq('«Выйти» из окна: выход', [calls.quit, closeWindow()], [1, false]);
    core.close();
    await wait(300);
    eq('после выхода значок не появляется', trays.length, 1);
    return finish();
  }

  // ───────── core.txt установлен, копия не установленная ─────────
  eq('id ярлыка — только у установленной копии', calls.aumid, []);
  eq('core.txt установлен: сначала своего значка нет', trays.length, 0);
  eq('...и выход пока не в окне', info().quitHere, false);
  await until(() => trays.length > 0, 4000);
  const shownAfter = Date.now() - started;
  eq('core.txt молчит: свой значок через ~3 с', [trays.length, shownAfter >= 2800 && shownAfter < 3900], [1, true]);
  const own = trays[0];
  eq('своё меню — полное', own.menu.map((i) => i.label || i.type), ['Открыть aura.txt', 'separator', 'Обработка голоса', 'Заглушить микрофон', 'Готовый звук', 'Эффект', 'separator', 'Открыть core.txt', 'Запускать вместе с Windows', 'separator', 'Выход']);
  own.menu.find((i) => i.label === 'Запускать вместе с Windows').click({ checked: true });
  eq('автозапуск из меню значка: окно перечитывает', [calls.login.slice(-1)[0], sentNames().slice(-1)[0]], [{ openAtLogin: true, args: ['--hidden'] }, 'autostart']);

  // окно сообщает клавиши и состояние, как при своём запуске
  const failedKeys = await handles['hotkeys:set']({}, { power: 'Ctrl+Shift+F9', mute: 'Ctrl+Shift+F10', pads: [null, 'Ctrl+Alt+Q'], padNames: ['Бонк', 'Сирена'], voices: [['robot', 'Ctrl+Alt+R']] });
  eq('hotkeys:set: не занялись', failedKeys, ['Ctrl+Alt+R']);
  eq('hotkeys:set: занятые', [...shortcuts.keys()], ['Ctrl+Shift+F9', 'Ctrl+Shift+F10', 'Ctrl+Alt+R', 'Ctrl+Alt+Q', 'Ctrl+Alt+1']);
  shortcuts.get('Ctrl+Alt+Q')();
  shortcuts.get('Ctrl+Alt+R')();
  shortcuts.get('Ctrl+Shift+F9')();
  eq('клавиши доходят до окна', sentNames().slice(-3), ['pad:1', 'voice:robot', 'power']);
  const ui = (o) => listeners['ui:state']({}, Object.assign({ on: true, mute: false, system: true, preset: 'studio', presetName: 'Подкаст', presets: [{ id: 'studio', name: 'Подкаст' }], voice: 'none', voices: [{ id: 'none', name: 'Обычный голос' }, { id: 'robot', name: 'Робот' }] }, o));
  ui({});
  eq('свой значок следует за окном', [own.tip, own.menu[2].checked], ['aura.txt — Подкаст', true]);

  // core.txt приходит и берёт один значок на всех
  const seen = {}, coreShow = [];
  let core = coreLink(seen, coreShow);
  await until(() => core.online);
  core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
  await until(() => seen['aura.tray'] && seen['aura.keys'] && seen['aura.voice']);
  eq('aura.tray', seen['aura.tray'], { items: [{ key: 'show', label: 'Открыть' }, { key: 'power', label: 'Обработка голоса', check: true }, { key: 'mute', label: 'Заглушить микрофон', check: false }] });
  eq('aura.keys', seen['aura.keys'].keys, [
    { id: 'power', label: 'Обработка голоса', keys: 'Ctrl+Shift+F9', on: true },
    { id: 'mute', label: 'Заглушить микрофон', keys: 'Ctrl+Shift+F10', on: true },
    { id: 'voice.robot', label: 'Эффект «Робот»', keys: 'Ctrl+Alt+R', on: true },
    { id: 'pad.0', label: 'Звук «Бонк»', keys: 'Ctrl+Alt+1', on: true },
    { id: 'pad.1', label: 'Звук «Сирена»', keys: 'Ctrl+Alt+Q', on: true },
  ]);
  await wait(1000);
  eq('через 1 с после core.txt свой значок ещё есть, выход — в его меню', [own.destroyed, info().quitHere], [false, false]);
  await until(() => own.destroyed, 1500);
  eq('через ~1,5 с свой значок убран', own.destroyed, true);
  eq('окно узнало: выход — в «Настройках»', [sentNames().slice(-1)[0], info().quitHere], ['family', true]);

  // общее меню core.txt управляет aura.txt
  eq('tray.run power', await core.command('aura', 'tray.run', { key: 'power' }), { ok: true, data: null });
  eq('tray.run mute', await core.command('aura', 'tray.run', { key: 'mute' }), { ok: true, data: null });
  eq('tray.run дошли до окна', sentNames().filter((x) => x !== 'family').slice(-2), ['power', 'mute']);
  ui({ on: false, system: false });
  await until(() => seen['aura.tray'].items[2].enabled === false);
  eq('aura.tray заново', seen['aura.tray'].items.slice(1), [{ key: 'power', label: 'Обработка голоса', check: false }, { key: 'mute', label: 'Заглушить микрофон', check: false, enabled: false }]);
  const r = await core.command('aura', 'tray.run', { key: 'mute' });
  eq('tray.run: недоступный пункт', [r.ok, r.error], [false, 'пункт сейчас недоступен']);
  win.visible = false;
  eq('tray.run show', await core.command('aura', 'tray.run', { key: 'show' }), { ok: true, data: null });
  eq('окно открыто', win.visible, true);
  win.visible = false;
  await core.command('aura', 'show', { page: 'keys' });
  eq('show {page: keys}', [win.visible, sentNames().slice(-1)[0]], [true, 'page:keys']);
  const n = win.sent.length;
  await core.command('aura', 'show', {});
  eq('show без страницы — без page', win.sent.slice(n).some((s) => s[1] === 'page'), false);

  // звуки, эффекты и пати: команды идут в окно (оно не показывается), ответ окна с data — результат; состояния — из окна
  const maskaSeen = {};
  const maska = connect({ app: 'maska', name: 'Maska', port: server.port, topics: ['hub.apps', 'aura.*'], onState: (t, d) => { maskaSeen[t] = d; } });
  await until(() => maska.online && maskaSeen['hub.apps']);
  const NEW_COMMANDS = ['sounds.play', 'sounds.stop', 'effects.set', 'effects.off', 'party.start', 'party.stop', 'party.answer'];
  const auraApp = (maskaSeen['hub.apps'] || []).find((a) => a.app === 'aura');
  eq('hub.apps: aura умеет звуки, эффекты, пати', NEW_COMMANDS.filter((c) => auraApp && auraApp.commands.includes(c)), NEW_COMMANDS);
  const asked = [];
  let reply = null; // (kind, key, value) → аргументы hub:result после id: ok, error, data
  const send = win.webContents.send;
  win.webContents.send = (...a) => {
    send(...a);
    if (a[0] !== 'hub:command') return;
    asked.push(a.slice(2));
    if (reply) setImmediate(() => listeners['hub:result']({}, a[1], ...reply(a[2], a[3], a[4])));
  };
  win.visible = false;
  reply = (kind, key) => [true, null, key === 'party.start' ? { code: 'ABCD-EFGH' } : undefined];
  eq('party.start: data окна — результат', await maska.command('aura', 'party.start', {}), { ok: true, data: { code: 'ABCD-EFGH' } });
  eq('sounds.play: без data — null', await maska.command('aura', 'sounds.play', { id: 'p1' }), { ok: true, data: null });
  eq('...до окна дошли имя и args', asked.slice(-1), [['cmd', 'sounds.play', { id: 'p1' }]]);
  await maska.command('aura', 'effects.off');
  eq('без args — пустой объект', asked.slice(-1), [['cmd', 'effects.off', {}]]);
  eq('settings.set по-прежнему: key, value, data null', [await maska.command('aura', 'settings.set', { key: 'auto', value: true }), asked.slice(-1)], [{ ok: true, data: null }, [['set', 'auto', true]]]);
  eq('окно не показано', win.visible, false);
  reply = () => [false, 'такого звука нет'];
  const bad = await maska.command('aura', 'sounds.play', { id: 'нет' });
  eq('ошибка окна — ok: false с текстом', [bad.ok, bad.error], [false, 'такого звука нет']);
  reply = null;
  win.webContents.send = send;
  const sounds = { mic: true, pads: [{ id: 'p1', name: 'Бонк' }], playing: ['p1'] };
  listeners['hub:state']({}, 'aura.evil', { x: 1 });
  listeners['hub:state']({}, 'aura.party', [1, 2]);
  listeners['hub:state']({}, 'aura.sounds', sounds);
  await until(() => maskaSeen['aura.sounds']);
  eq('hub:state: тема из списка публикуется', maskaSeen['aura.sounds'], sounds);
  await wait(150);
  eq('hub:state: чужая тема и не объект — нет', ['aura.evil' in maskaSeen, 'aura.party' in maskaSeen], [false, false]);
  maska.close();

  // дорога к core.txt
  eq('core:info', info(), { online: true, installed: true, quitHere: true });
  await handles['core:go']({}, 'general');
  await handles['core:go']({}, 'evil');
  await handles['core:go']({});
  eq('core:go: страницы', coreShow.slice(-3), [{ page: 'general' }, {}, {}]);

  // первое закрытие: показать негде (значок у core.txt, острова нет, копия не установленная) — не отмечается
  eq('закрытие оставляет aura.txt работать', closeWindow(), true);
  eq('ни острова, ни своего значка: подсказки нет, не отмечено', [balloons.length, toasts.length, fs.existsSync(flag)], [0, 0, false]);
  const notes = [];
  const island = connect({ app: 'kapsula', name: 'kapsula.txt', port: server.port, commands: { notify: (a) => { notes.push(a); return null; } } });
  await until(() => island.online);
  await wait(150); // hub.apps доходит до aura.txt
  closeWindow();
  await until(() => notes.length === 1);
  eq('подсказка — на остров', notes[0], { title: 'aura.txt работает в фоне', text: 'Голос продолжает обрабатываться. Окно открывается из меню core.txt в трее, а выйти можно в «Настройках».', open: true });
  eq('подсказка отмечена', fs.existsSync(flag), true);
  fs.rmSync(flag);

  // core.txt закрылся: свой значок сразу
  const pushesBefore = familyPushes();
  core.close();
  await until(() => trays.length === 2, 1000);
  eq('core.txt ушёл: свой значок сразу', [trays.length, trays[1].destroyed], [2, false]);
  eq('...окно узнало, выход снова в меню значка', [familyPushes() > pushesBefore, info().quitHere], [true, false]);
  closeWindow();
  await until(() => notes.length === 2);
  eq('со своим значком: на остров — подсказка про рыбку', notes[1].text, 'Голос продолжает обрабатываться. Чтобы закрыть совсем — правый клик по рыбке → «Выход».');
  fs.rmSync(flag);
  island.close();
  await wait(200);
  closeWindow();
  eq('без острова: подсказка у своего значка', [balloons.length, balloons[0] && balloons[0].title, toasts.length, fs.existsSync(flag)], [1, 'aura.txt осталась в трее', 0, true]);

  // core.txt вернулся сразу: значок убирается дольше (без мигания)
  core = coreLink(seen);
  await until(() => core.online);
  core.state('core.family', { tray: true });
  await wait(3000);
  eq('значок только что вернулся: через 3 с ещё есть', trays[1].destroyed, false);
  await until(() => trays[1].destroyed, 7000);
  eq('...и убран через ~8 с', trays[1].destroyed, true);

  // хаба нет: core.txt запускается сразу на нужной странице
  core.close();
  await stopServer();
  await until(() => trays.length === 3 && !info().online, 3000);
  eq('хаб пропал: свой значок сразу', [trays.length, trays[2].destroyed, info().online], [3, false, false]);
  await handles['core:go']({}, 'general');
  await handles['core:go']({}, 'evil');
  await handles['core:go']({});
  eq('core:go без связи: запуск core.txt с --page', spawned, [['Core.exe', '--page', 'general'], ['Core.exe'], ['Core.exe']]);

  // выход кнопкой в окне: значок больше не появляется
  await handles['app:quit']();
  eq('«Выйти» из окна', [calls.quit, closeWindow()], [1, false]);
  await wait(300);
  eq('после выхода значок не создаётся заново', trays.length, 3);
  return finish();
})().catch((e) => {
  console.log('FAIL ' + (e && e.stack));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

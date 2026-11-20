// Проверки family.js без Electron: запись сочетаний, пункты трея и клавиш, разбор core.family, связь с семьёй и
// когда появляется свой значок в трее. Запуск: node scripts/family-test.js
// С образцовым хабом из kit.txt — ещё и обмен по протоколу (на свободном порту, не на 42080 настоящего core.txt):
//   node scripts/family-test.js --hub <kit.txt>/hub/hub.js
'use strict';
const path = require('path');
const f = require('../family');

let failed = 0, passed = 0;
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) passed++;
  else {
    failed++;
    console.log('FAIL ' + name + '\n  получено: ' + a + '\n  ожидалось: ' + b);
  }
}
function throwsWith(name, fn, text) {
  try {
    fn();
    eq(name + ' — бросает', 'не бросило', text);
  } catch (e) {
    eq(name, String(e && e.message), text);
  }
}

// ───────── Запись сочетаний: как KeyNames.Normal в Family.cs ─────────
const keys = [
  ['', ''], [null, ''], [undefined, ''], ['   ', ''],
  ['alt + ctrl+s', 'Ctrl+Alt+S'], ['Ctrl+Shift+F9', 'Ctrl+Shift+F9'], ['shift+ctrl+f10', 'Ctrl+Shift+F10'],
  ['Ctrl+Alt+num5', 'Ctrl+Alt+Num5'], ['CommandOrControl+Alt+K', 'Ctrl+Alt+K'], ['Super+Space', 'Win+Space'],
  ['Ctrl++', 'Ctrl+='], ['Ctrl+Plus', 'Ctrl+='], ['win', 'Win'], ['Alt+Tab', 'Alt+Tab'], ['Ctrl+Alt+Escape', 'Ctrl+Alt+Esc'],
  ['ctrl+alt+pgdn', 'Ctrl+Alt+PageDown'], ['Alt+`', 'Alt+`'], ['alt+~', 'Alt+`'], ['Ctrl+Shift+MediaPlayPause', 'Ctrl+Shift+PlayPause'],
  ['Shift+Alt+Ctrl+X', 'Ctrl+Alt+Shift+X'], ['meta+shift+a', 'Shift+Win+A'], ['F5', 'F5'], ['Ctrl+Alt+Insert', 'Ctrl+Alt+Insert'],
  ['constructor', 'Constructor'], ['Ctrl+toString', 'Ctrl+ToString'], ['Ctrl+Alt', 'Ctrl+Alt'],
];
for (const [text, want] of keys) eq('normalKeys(' + JSON.stringify(text) + ')', f.normalKeys(text), want);

// ───────── Какие сочетания aura.txt умеет занять ─────────
for (const a of ['Ctrl+Shift+F9', 'F7', 'Ctrl+Alt+num3', 'Alt+Space', 'Ctrl+Alt+Shift+PageUp', 'Ctrl+1']) eq('accelOk ' + a, f.accelOk(a), true);
for (const a of ['', 'Win+X', 'Ctrl+?', 'ctrl+s', 'Ctrl+Ctrl+Ctrl+Ctrl+S', 'Ctrl+Alt+Delete', null, 5]) eq('accelOk ' + a, f.accelOk(a), false);

// ───────── План клавиш: тот же порядок и те же правила, что были в main.js ─────────
const config = {
  power: 'Ctrl+Shift+F9', mute: 'Ctrl+Shift+F10',
  voices: [['robot', 'Ctrl+Alt+R'], null, 'ab', ['Robot', 'Ctrl+Alt+T'], ['girl', 5], ['kid', 'Ctrl+Alt+R']],
  pads: [null, null, 'Ctrl+Alt+Q', null, null, null, null, null, null, null, null], padNames: ['Бонк', 'Вау', 'Сирена'],
};
const plan = f.hotkeyPlan(config);
eq('план: порядок', plan.map((k) => k.id + '=' + k.accel), [
  'power=Ctrl+Shift+F9', 'mute=Ctrl+Shift+F10', 'voice.robot=Ctrl+Alt+R', 'pad.2=Ctrl+Alt+Q',
  'pad.0=Ctrl+Alt+1', 'pad.1=Ctrl+Alt+2', 'pad.3=Ctrl+Alt+4', 'pad.4=Ctrl+Alt+5', 'pad.5=Ctrl+Alt+6', 'pad.6=Ctrl+Alt+7', 'pad.7=Ctrl+Alt+8', 'pad.8=Ctrl+Alt+9',
]);
eq('план: действия', plan.slice(0, 4).map((k) => [k.action, k.arg === undefined ? null : k.arg]), [['power', null], ['mute', null], ['voice', 'robot'], ['pad', 2]]);
eq('план: одно сочетание — одно действие', f.hotkeyPlan({ power: 'Ctrl+Alt+M', mute: 'Ctrl+Alt+M' }).map((k) => k.id), ['power']);
eq('план: своя клавиша звука сильнее чужой по умолчанию', f.hotkeyPlan({ pads: ['Ctrl+Alt+2', null] }).map((k) => k.id + '=' + k.accel), ['pad.0=Ctrl+Alt+2']);
eq('план: не объект', f.hotkeyPlan(null), []);
eq('план: десятый звук без клавиши — без клавиши', f.hotkeyPlan({ pads: new Array(12).fill(null) }).length, 9);

// ───────── aura.keys ─────────
const voices = new Map([['robot', 'Робот'], ['kid', 'Ребёнок']]);
const list = f.auraKeys(config, { voices });
eq('клавиши: первые', list.slice(0, 4), [
  { id: 'power', label: 'Обработка голоса', keys: 'Ctrl+Shift+F9', on: true },
  { id: 'mute', label: 'Заглушить микрофон', keys: 'Ctrl+Shift+F10', on: true },
  { id: 'voice.robot', label: 'Эффект «Робот»', keys: 'Ctrl+Alt+R', on: true },
  { id: 'pad.0', label: 'Звук «Бонк»', keys: 'Ctrl+Alt+1', on: true },
]);
eq('клавиши: звуки по порядку', list.filter((k) => k.id.startsWith('pad.')).map((k) => k.id), ['pad.0', 'pad.1', 'pad.2', 'pad.3', 'pad.4', 'pad.5', 'pad.6', 'pad.7', 'pad.8']);
eq('клавиши: звук без названия', list.find((k) => k.id === 'pad.3').label, 'Звук 4');
eq('клавиши: без сочетания — выключено', f.auraKeys({ power: '', mute: 'Ctrl+Shift+F10' }).slice(0, 2), [
  { id: 'power', label: 'Обработка голоса', keys: '', on: false },
  { id: 'mute', label: 'Заглушить микрофон', keys: 'Ctrl+Shift+F10', on: true },
]);
eq('клавиши: совпало с обработкой — не занято', f.auraKeys({ power: 'Ctrl+Alt+M', mute: 'Ctrl+Alt+M' })[1], { id: 'mute', label: 'Заглушить микрофон', keys: 'Ctrl+Alt+M', on: false });
eq('клавиши: незнакомый голос — по имени', f.auraKeys({ voices: [['alien', 'Ctrl+Alt+P']] })[2].label, 'Эффект «alien»');
eq('клавиши: Num в общей записи', f.auraKeys({ pads: ['Ctrl+num7'], padNames: ['Тук'] })[2], { id: 'pad.0', label: 'Звук «Тук»', keys: 'Ctrl+Num7', on: true });
const mods = ['Ctrl+', 'Alt+', 'Shift+', 'Ctrl+Alt+'];
const many = { pads: Array.from({ length: 104 }, (_, i) => mods[Math.floor(i / 26)] + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i % 26]) };
eq('клавиши: занято больше 64', f.hotkeyPlan(many).length, 104);
eq('клавиши: в core.txt — не больше 64', f.auraKeys(many).length, 64);

// ───────── aura.tray ─────────
const runs = [];
const actions = { show: () => runs.push('show'), power: () => runs.push('power'), mute: () => runs.push('mute') };
eq('трей: без модуля', f.auraTray({ on: true, mute: false, system: false }, actions).map(f.trayItemData), [
  { key: 'show', label: 'Открыть' },
  { key: 'power', label: 'Обработка голоса', check: true },
  { key: 'mute', label: 'Заглушить микрофон', check: false, enabled: false },
]);
eq('трей: с модулем', f.auraTray({ on: false, mute: true, system: true }, actions).map(f.trayItemData)[2], { key: 'mute', label: 'Заглушить микрофон', check: true });
eq('трей: без ui', f.auraTray(null, actions).map(f.trayItemData)[1], { key: 'power', label: 'Обработка голоса', check: false });

// ───────── core.family и hub.apps ─────────
eq('core.family: не объект', [null, [], 'x', 5, true].map(f.familyState), [null, null, null, null, null]);
eq('core.family: разбор', f.familyState({ tray: true, focus: 'yes', focusUntil: 1763600000000.7, game: 1, gameApp: 5 }), { tray: true, focus: false, focusUntil: 1763600000000, game: false, gameApp: '' });
eq('core.family: плохое время', [-5, NaN, Infinity, '123', null, true].map((v) => f.familyState({ focusUntil: v }).focusUntil), [0, 0, 0, 0, 0, 0]);
eq('core.family: всё есть', f.familyState({ tray: false, focus: true, focusUntil: 1000, game: true, gameApp: 'cs2' }), { tray: false, focus: true, focusUntil: 1000, game: true, gameApp: 'cs2' });
eq('focusEnds', [f.focusEnds({ focus: true, focusUntil: 1000 }).getTime(), f.focusEnds({ focus: true, focusUntil: 0 }), f.focusEnds({ focus: false, focusUntil: 1000 }), f.focusEnds(null)], [1000, null, null, null]);
const apps = f.appsFrom([{ app: 'kapsula', commands: ['notify', 5, 'show'] }, { app: 7 }, null, 'x', { app: 'core' }, [1]]);
eq('hub.apps', [...apps].map(([a, c]) => [a, [...c]]), [['kapsula', ['notify', 'show']], ['core', []]]);
eq('hub.apps: не список', f.appsFrom({ app: 'core' }).size, 0);
eq('cut', [f.cut('  abc  ', 60), f.cut('x'.repeat(61), 60).length, f.cut('x'.repeat(61), 60).slice(-1), f.cut(null, 5)], ['abc', 60, '…', '']);

// ───────── Family с поддельным хабом ─────────
function fakeHub() {
  return {
    online: true, states: [], commands: [], result: { ok: true, data: null },
    state(topic, data) { this.states.push([topic, data]); },
    command(to, name, args) { this.commands.push([to, name, args]); return Promise.resolve(this.result); },
  };
}
let changes = 0, ownStates = 0, ownStatus = [];
const fam = new f.Family('aura', () => changes++);
const opts = fam.wrap({ app: 'aura', topics: ['hub.theme', 'hub.apps'], commands: { show: () => 'own' }, onState: () => ownStates++, onStatus: (on) => ownStatus.push(on) });
eq('wrap: темы', opts.topics, ['hub.theme', 'hub.apps', 'core.family']);
eq('wrap: команды', Object.keys(opts.commands), ['show', 'tray.run']);
eq('wrap: своя команда цела', opts.commands.show(), 'own');
eq('до связи — своего значка не прятать', fam.hideOwnTray, false);
fam.setTray(f.auraTray({ on: false, mute: false, system: true }, actions)); // до attach: уйдёт при attach
const hub = fakeHub();
fam.attach(hub);
eq('attach отдаёт трей', hub.states.map((s) => s[0]), ['aura.tray']);
opts.onState('core.family', { tray: true, focus: true }, 'kapsula'); // чужое core.family не в счёт
eq('core.family не от core', [fam.hideOwnTray, changes, ownStates], [false, 0, 1]);
opts.onState('core.family', { tray: true, focus: true }, 'core');
eq('core.family от core', [fam.hideOwnTray, fam.focus, fam.game, fam.coreOnline, changes, ownStates], [true, true, false, true, 1, 2]);
hub.online = false;
eq('связь пропала — значок свой', [fam.hideOwnTray, fam.coreOnline], [false, false]);
hub.online = true;
opts.onState('hub.apps', [{ app: 'kapsula', commands: ['notify'] }, { app: 'core', commands: ['show', 'focus.set'] }], 'hub');
eq('hub.apps', [fam.islandOnline, fam.has('core', 'focus.set'), fam.has('core', 'notify'), changes], [true, true, false, 2]);
let lost = 0;
eq('notify на остров', fam.notify('  aura.txt  ', 'т'.repeat(250), true, () => lost++), true);
const sent = hub.commands[hub.commands.length - 1];
eq('notify: что ушло', [sent[0], sent[1], sent[2].title, sent[2].text.length, sent[2].text.slice(-1), sent[2].open], ['kapsula', 'notify', 'aura.txt', 200, '…', true]);
fam.notify('a', 'b', false);
eq('notify без open', 'open' in hub.commands[hub.commands.length - 1][2], false);
eq('setFocus', [fam.setFocus(true, 60), hub.commands[hub.commands.length - 1], fam.setFocus(false, 60), hub.commands[hub.commands.length - 1][2]], [true, ['core', 'focus.set', { on: true, minutes: 60 }], true, { on: false }]);
eq('трей: одно и то же второй раз не шлётся', [fam.setTray(f.auraTray({ on: false, mute: false, system: true }, actions)), hub.states.length], [false, 1]);
eq('трей: новые галочки шлются', [fam.setTray(f.auraTray({ on: true, mute: false, system: true }, actions)), hub.states.length, hub.states[1][1].items[1]], [true, 2, { key: 'power', label: 'Обработка голоса', check: true }]);
eq('трей: не больше четырёх', (fam.setTray([1, 2, 3, 4, 5, 6].map((i) => ({ key: 'k' + i, label: 'п' + i }))), hub.states[2][1].items.length), 4);
fam.setTray(f.auraTray({ on: true, mute: false, system: false }, actions));
eq('tray.run show', [opts.commands['tray.run']({ key: 'show' }), runs.slice(-1)[0]], [null, 'show']);
eq('tray.run power', [opts.commands['tray.run']({ key: 'power' }), runs.slice(-1)[0]], [null, 'power']);
throwsWith('tray.run: недоступный пункт', () => opts.commands['tray.run']({ key: 'mute' }), 'пункт сейчас недоступен');
throwsWith('tray.run: нет такого', () => opts.commands['tray.run']({ key: 'exit' }), 'такого пункта нет');
throwsWith('tray.run: без ключа', () => opts.commands['tray.run']({}), 'такого пункта нет');
fam.setKeys(f.auraKeys(config, { voices }));
eq('клавиши: ушли', hub.states[hub.states.length - 1][0], 'aura.keys');
const before = hub.states.length;
fam.setKeys(f.auraKeys(config, { voices }));
eq('клавиши: одно и то же второй раз не шлётся', hub.states.length, before);
opts.onStatus(false);
eq('связь пропала', [fam.coreOnline, fam.islandOnline, fam.notify('a', 'b', true), ownStatus, changes], [false, false, false, [false], 3]);
opts.onStatus(true);
eq('связь есть — ничего не меняется до core.family', [fam.coreOnline, changes, ownStatus], [false, 3, [false, true]]);

// ───────── Своё уведомление, если остров его так и не получил ─────────
async function lostChecks() {
  const h = fakeHub();
  const fm = new f.Family('aura');
  fm.attach(h);
  fm.take('hub.apps', [{ app: 'kapsula', commands: ['notify'] }], 'hub');
  let lostCount = 0;
  for (const error of ['offline', 'unknown-command', 'timeout', 'не смог']) {
    h.result = { ok: false, error };
    fm.notify('a', 'b', true, () => lostCount++);
    await new Promise((r) => setTimeout(r, 5));
  }
  eq('остров не получил — своё уведомление (offline, unknown-command), а не при timeout и отказе', lostCount, 2);
}

// ───────── Когда есть свой значок ─────────
function clock() {
  const c = { t: 0, seq: 0, list: [] };
  c.timers = {
    set: (fn, ms) => { const id = ++c.seq; c.list.push({ id, at: c.t + ms, fn }); return id; },
    clear: (id) => { c.list = c.list.filter((x) => x.id !== id); },
    now: () => c.t,
  };
  c.go = (ms) => {
    const end = c.t + ms;
    for (;;) {
      c.list.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = c.list[0];
      if (!next || next.at > end) break;
      c.list.shift();
      c.t = next.at;
      next.fn();
    }
    c.t = end;
  };
  return c;
}
function gate(waitMs) {
  const c = clock();
  const log = [];
  const g = new f.TrayGate((show) => log.push((show ? '+' : '-') + c.t), { timers: c.timers });
  g.start(waitMs);
  return { c, log, g };
}
{
  const { log } = gate(0);
  eq('значок: core.txt не установлен — сразу', log, ['+0']);
}
{
  const { c, log, g } = gate(3000);
  c.go(400);
  g.set(true, true);
  c.go(10000);
  eq('значок: core.txt взял его при запуске — не мелькает', log, []);
}
{
  const { c, log } = gate(3000);
  c.go(2999);
  eq('значок: ждём core.txt до трёх секунд', log, []);
  c.go(1);
  eq('значок: core.txt молчит — свой через три секунды', log, ['+3000']);
}
{
  const { c, log, g } = gate(3000);
  c.go(500);
  g.set(false, true);
  eq('значок: core.txt отдал значок — свой сразу', log, ['+500']);
}
{
  const { c, log, g } = gate(3000);
  c.go(1000);
  g.set(false, false); // связь есть, но core.family ещё не пришло
  c.go(1000);
  eq('значок: без ответа core.txt ждём дальше', log, []);
  c.go(1000);
  eq('значок: ...но не дольше трёх секунд', log, ['+3000']);
}
{
  const { c, log, g } = gate(3000);
  c.go(300);
  g.set(true, true);
  c.go(700);
  g.set(false, false); // связь пропала
  eq('значок: связь пропала после ответа — свой сразу, без ожидания', log, ['+1000']);
}
{
  const { c, log, g } = gate(0);
  c.go(1000);
  g.set(true, true);
  c.go(1499);
  eq('значок: убирается не сразу', log, ['+0']);
  c.go(1);
  eq('значок: ...а через полторы секунды', log, ['+0', '-2500']);
  c.go(5000);
  g.set(false, false);
  eq('значок: связь пропала — сразу обратно', log, ['+0', '-2500', '+7500']);
  c.go(1000);
  g.set(true, true);
  c.go(7999);
  eq('значок: только что возвращался — убирается дольше', log, ['+0', '-2500', '+7500']);
  c.go(1);
  eq('значок: ...через восемь секунд', log, ['+0', '-2500', '+7500', '-16500']);
  c.go(61000);
  g.set(false, false);
  c.go(61000);
  g.set(true, true);
  c.go(1500);
  eq('значок: через минуту снова как обычно', log.slice(-2), ['+77500', '-140000']);
}
{
  const { c, log, g } = gate(0);
  for (let i = 0; i < 20; i++) {
    c.go(1000);
    g.set(i % 2 === 0, i % 2 === 0);
  }
  c.go(500);
  eq('значок: мигающая связь — значок не мигает', log, ['+0']);
}
{
  const { c, log, g } = gate(0);
  c.go(100);
  g.set(true, true);
  g.stop();
  c.go(5000);
  g.set(false, false);
  eq('значок: после stop() не трогается', log, ['+0']);
}
{
  const c = clock();
  const log = [];
  const g = new f.TrayGate((show) => log.push(show), { timers: c.timers });
  g.set(true, true); // core.family пришло раньше start()
  g.start(3000);
  c.go(1000);
  eq('значок: core.txt ответил ещё до start()', log, []);
  g.set(false, false);
  eq('значок: ...и связь пропала — свой сразу', log, [true]);
}
{
  const c = clock();
  const log = [];
  const g = new f.TrayGate((show) => log.push((show ? '+' : '-') + c.t), { timers: c.timers });
  g.set(false, true); // core.txt ещё до start() ответил, что значок не берёт
  g.start(3000);
  eq('значок: core.txt отдал значок ещё до start() — свой сразу, без ожидания', log, ['+0']);
}

// ───────── По-настоящему: хаб из kit.txt, клиент hub-client.js ─────────
async function protocol(hubPath) {
  const { start } = require(path.resolve(hubPath));
  const { connect } = require('../hub-client');
  const server = await start({ port: 0 });
  if (server.port === 42080) throw new Error('это порт настоящего core.txt');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (name, test, ms) => {
    for (let t = 0; t < (ms || 3000); t += 20) {
      if (test()) return true;
      await wait(20);
    }
    eq(name + ' (не дождались)', false, true);
    return false;
  };
  const seen = {}; // что видит core.txt: темы aura.*
  const notes = [];
  let changes = 0;
  const ran = [];
  const fam = new f.Family('aura', () => changes++);
  const aura = connect(fam.wrap({ app: 'aura', name: 'aura.txt', version: 'test', port: server.port, topics: ['hub.theme'], commands: { show: () => null } }));
  fam.attach(aura);
  fam.setTray(f.auraTray({ on: false, mute: false, system: true }, { show: () => ran.push('show'), power: () => ran.push('power'), mute: () => ran.push('mute') }));
  fam.setKeys(f.auraKeys({ power: 'Ctrl+Shift+F9', mute: 'Ctrl+Shift+F10', pads: [null] , padNames: ['Бонк'] }));
  const core = connect({ app: 'core', name: 'core.txt', port: server.port, topics: ['aura.*'], commands: { show: () => null, 'focus.set': () => null }, onState: (t, d) => (seen[t] = d) });
  await until('core.txt и aura.txt на связи', () => core.online && aura.online);
  core.state('core.family', { tray: true, focus: false, focusUntil: 0, game: false, gameApp: '' });
  await until('aura.txt видит, что значок у core.txt', () => fam.hideOwnTray);
  await until('core.txt видит aura.tray и aura.keys', () => seen['aura.tray'] && seen['aura.keys']);
  eq('протокол: aura.tray', seen['aura.tray'], { items: [{ key: 'show', label: 'Открыть' }, { key: 'power', label: 'Обработка голоса', check: false }, { key: 'mute', label: 'Заглушить микрофон', check: false }] });
  eq('протокол: aura.keys', seen['aura.keys'].keys.map((k) => k.label + ' ' + k.keys), ['Обработка голоса Ctrl+Shift+F9', 'Заглушить микрофон Ctrl+Shift+F10', 'Звук «Бонк» Ctrl+Alt+1']);
  eq('протокол: tray.run power', [await core.command('aura', 'tray.run', { key: 'power' }), ran], [{ ok: true, data: null }, ['power']]);
  const bad = await core.command('aura', 'tray.run', { key: 'quit' });
  eq('протокол: tray.run незнакомый', [bad.ok, bad.error], [false, 'такого пункта нет']);
  eq('протокол: без острова notify не идёт', fam.notify('aura.txt', 'текст', true), false);
  const island = connect({ app: 'kapsula', name: 'kapsula.txt', port: server.port, commands: { notify: (args) => { notes.push(args); return null; } } });
  await until('остров на связи', () => fam.islandOnline);
  eq('протокол: notify ушёл', fam.notify('aura.txt', 'Голос продолжает обрабатываться.', true), true);
  await until('остров получил уведомление', () => notes.length === 1);
  eq('протокол: что получил остров', notes[0], { title: 'aura.txt', text: 'Голос продолжает обрабатываться.', open: true });
  core.close(); // core.txt закрылся, а хаб (здесь — образцовый) жив: его состояния пришли с null
  await until('core.txt ушёл — свой значок снова нужен', () => !fam.hideOwnTray && !fam.coreOnline);
  island.close();
  await until('остров ушёл', () => !fam.islandOnline);
  await server.stop();
  await until('хаб пропал', () => !aura.online);
  aura.close();
}

(async () => {
  await lostChecks();
  const at = process.argv.indexOf('--hub');
  const hubPath = at >= 0 ? process.argv[at + 1] : process.env.KIT_HUB;
  if (hubPath) await protocol(hubPath);
  else console.log('протокол не проверялся: укажите --hub <kit.txt>/hub/hub.js');
  console.log((failed ? 'НЕ ПРОШЛО: ' + failed : 'всё прошло') + ' · проверок: ' + (passed + failed));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL ' + (e && e.stack));
  process.exit(1);
});

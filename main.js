const { app, BrowserWindow, session, ipcMain, Tray, Menu, globalShortcut, dialog, shell, nativeTheme } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Dev-only flags: --shot=<png> saves a screenshot and quits, --test runs the DSP self-check.
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const testMode = process.argv.includes('--test');
const probeMode = process.argv.includes('--probe'); // dev: switch on for one run without saving
const devRun = !!shotArg || testMode || probeMode;
const tabArg = process.argv.find((a) => a.startsWith('--tab=')); // dev: open on a given page
const dataArg = process.argv.find((a) => a.startsWith('--data=')); // dev: worst-case fixtures (app/dev-fixtures.js)
const sizeArg = process.argv.find((a) => a.startsWith('--size=')); // dev: WIDTHxHEIGHT
const zoomArg = process.argv.find((a) => a.startsWith('--zoom='));
const themeArg = process.argv.find((a) => a.startsWith('--theme=')); // dev: light | dark
const clickSelector = process.env.AURA_CLICK; // dev: click this selector partway through a --shot run
const startHidden = process.argv.includes('--hidden'); // launched with Windows: straight to the tray
const asset = (name) => path.join(__dirname, 'assets', name);

// Let the audio engine start on launch, without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Dev runs get a profile of their own: they must never read or overwrite the installed app's settings.
if (devRun) app.setPath('userData', path.join(app.getPath('temp'), 'aura-dev-profile'));
if (shotArg) app.disableHardwareAcceleration(); // dev screenshots: software rendering works with the display off

if (!devRun && !app.requestSingleInstanceLock()) app.quit();

let win;
let tray;
let quitting = false;
let ui = { on: false, mute: false, system: false, preset: '', presetName: '', presets: [], voice: 'none', voices: [] }; // what the window last reported
const HOTKEY_POWER = 'Ctrl+Shift+F9';
const HOTKEY_MUTE = 'Ctrl+Shift+F10';
let hotkeys = { power: HOTKEY_POWER, mute: HOTKEY_MUTE }; // what the window last asked for

function createWindow() {
  if (devRun && themeArg) nativeTheme.themeSource = themeArg.slice('--theme='.length) === 'light' ? 'light' : 'dark';
  win = new BrowserWindow({
    width: 1060,
    height: 900,
    minWidth: 940,
    minHeight: 700,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    title: 'Aura',
    icon: asset('icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#ffffff' : '#000000', height: 30 },
    webPreferences: {
      // The voice must keep flowing while the window is minimised.
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      offscreen: !!shotArg, // dev screenshots render in memory, so they work with the display locked or off
    },
  });

  win.removeMenu();
  // Light or dark with Windows, live: the page follows through prefers-color-scheme, the window
  // buttons and the colour shown before the page paints have to be told.
  nativeTheme.on('updated', () => {
    if (win.isDestroyed()) return;
    const dark = nativeTheme.shouldUseDarkColors;
    win.setBackgroundColor(dark ? '#1c1c1e' : '#f2f2f7');
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#ffffff' : '#000000', height: 30 });
  });
  if (devRun && sizeArg) {
    const [w, h] = sizeArg.slice('--size='.length).split('x').map(Number);
    win.setMinimumSize(300, 300);
    win.setContentSize(w, h);
  }
  // Chromium remembers the zoom per profile, so dev runs always set it — back to 1 unless asked otherwise.
  if (devRun) win.webContents.once('did-finish-load', () => win.webContents.setZoomFactor(zoomArg ? Number(zoomArg.slice('--zoom='.length)) : 1));
  win.loadFile(path.join(__dirname, 'app', 'index.html'), {
    query: { ...(testMode ? { test: '1' } : probeMode ? { probe: '1' } : {}), ...(tabArg ? { tab: tabArg.slice('--tab='.length) } : {}), ...(devRun && dataArg ? { data: dataArg.slice('--data='.length) } : {}) },
  });
  win.once('ready-to-show', () => {
    if (!startHidden && !shotArg) win.show();
  });
  // The window keeps running in the tray (the audio needs it), but it has no business drawing there.
  const tellVisible = () => command('visible', win.isVisible() && !win.isMinimized());
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, tellVisible);

  // Closing the window keeps Aura in the tray: the voice stays on, like a proper background utility.
  win.on('close', (e) => {
    if (quitting || devRun) return;
    e.preventDefault();
    win.hide();
    const flag = path.join(app.getPath('userData'), 'tray-hint-shown');
    if (!fs.existsSync(flag)) {
      fs.writeFileSync(flag, '');
      tray?.displayBalloon({
        title: 'Aura осталась в трее',
        content: 'Голос продолжает обрабатываться. Чтобы закрыть совсем — правый клик по рыбке → «Выйти».',
        icon: asset('icon.png'),
      });
    }
  });

  if (shotArg || testMode || probeMode) {
    // dev: AURA_HIDE_TEST=1 measures how many animation frames the page gets while shown and while hidden.
    if (process.env.AURA_HIDE_TEST) {
      const count = "new Promise((r) => { let n = 0; const t = performance.now(); (function f() { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else r(n); })(); setTimeout(() => r(n), 1500); })";
      const appFrames = "new Promise((r) => { const a = lastFrame; setTimeout(() => r(lastFrame !== a), 700); })";
      setTimeout(async () => {
        const js = (code) => win.webContents.executeJavaScript(code).catch((e) => 'failed: ' + e.message);
        console.log('[hide-test] shown : raw rAF/s =', await js(count), '| app loop running =', await js(appFrames), '| document.hidden =', await js('document.hidden'));
        win.hide();
        await new Promise((r) => setTimeout(r, 800));
        console.log('[hide-test] hidden: raw rAF/s =', await js(count), '| app loop running =', await js(appFrames), '| document.hidden =', await js('document.hidden'), '| windowVisible =', await js('windowVisible'));
        win.show();
        await new Promise((r) => setTimeout(r, 800));
        console.log('[hide-test] reshown: app loop running =', await js(appFrames), '| windowVisible =', await js('windowVisible'));
      }, 2500);
    }
    // dev: AURA_EARLY_SHOT=<ms after load> saves an extra frame, e.g. to look at the launch animation
    if (shotArg && process.env.AURA_EARLY_SHOT) {
      win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            fs.writeFileSync(shotArg.slice('--shot='.length).replace(/.png$/, '-early.png'), (await win.webContents.capturePage()).toPNG());
          } catch (err) {
            console.log('[early shot] failed:', err.message);
          }
        }, Number(process.env.AURA_EARLY_SHOT));
      });
    }
    if (shotArg && clickSelector) {
      setTimeout(async () => {
        const result = await win.webContents
          .executeJavaScript(`(async () => { for (let i = 0; i < 40; i++) { const el = document.querySelector(${JSON.stringify(clickSelector)}); if (el) { el.click(); return 'clicked ' + el.tagName + ' "' + el.textContent + '"'; } await new Promise((r) => setTimeout(r, 250)); } return 'no element'; })()`)
          .catch((err) => 'click failed: ' + err.message);
        console.log('[click]', result);
      }, 1500);
    }
    win.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.message);
    });
    setTimeout(async () => {
      if (shotArg) {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(shotArg.slice('--shot='.length), img.toPNG());
        } catch (err) {
          console.log('[shot] failed:', err.message);
        }
        // A text summary of what is on screen, for when a picture is not enough.
        const summary = await win.webContents
          .executeJavaScript("JSON.stringify({ tab: document.querySelector('.tabs [aria-selected=true]')?.textContent, pages: [...document.querySelectorAll('.page')].filter((p) => !p.hidden).map((p) => p.dataset.page), pads: [...document.querySelectorAll('.pad')].map((e) => e.textContent), added: document.querySelector('.catalog-row .pill')?.textContent, rows: document.querySelectorAll('.catalog-row').length, first: [...document.querySelectorAll('.catalog-title')].slice(0, 3).map((e) => e.textContent), note: document.querySelector('#catalogNote')?.textContent, status: document.querySelector('#status')?.textContent, intro: !!document.querySelector('#intro'), body: document.body.className, heroOpacity: getComputedStyle(document.querySelector('.hero')).opacity, fishCells: document.querySelectorAll('#introFish i').length })")
          .catch((err) => 'summary failed: ' + err.message);
        console.log('[dom]', summary);
      }
      app.quit();
    }, process.env.AURA_HIDE_TEST ? 12000 : probeMode ? 10000 : shotArg ? 14000 : 4500);
  }
}

/* ───── Soundboard files ─────
 * Sounds the user adds are copied into the app's own folder under a random name, so pads keep
 * working when the original file moves, and the page can only ever ask for files from there. */
const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
const soundId = /^[0-9a-f-]{36}\.(mp3|wav|ogg|m4a|flac|opus)$/;

ipcMain.handle('sounds:add', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Добавить звуки',
    filters: [{ name: 'Звуки', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled) return [];
  fs.mkdirSync(soundsDir(), { recursive: true });
  const added = [];
  for (const file of filePaths.slice(0, 50)) {
    try {
      const ext = path.extname(file).toLowerCase();
      const id = crypto.randomUUID() + ext;
      if (!soundId.test(id) || fs.statSync(file).size > 30e6) continue;
      fs.copyFileSync(file, path.join(soundsDir(), id));
      added.push({ id, name: path.basename(file, path.extname(file)).slice(0, 40) });
    } catch {}
  }
  return added;
});
ipcMain.handle('sounds:read', (_e, id) => {
  if (typeof id !== 'string' || !soundId.test(id)) return null;
  try {
    return fs.readFileSync(path.join(soundsDir(), id));
  } catch {
    return null;
  }
});
ipcMain.handle('sounds:remove', (_e, id) => {
  if (typeof id !== 'string' || !soundId.test(id)) return false;
  try {
    fs.rmSync(path.join(soundsDir(), id), { force: true });
  } catch {}
  return true;
});
// The decoded clip for the module: raw mono float32 at 48 kHz, at most 20 seconds.
ipcMain.handle('sounds:clip', (_e, samples) => {
  if (!(samples instanceof Float32Array) || samples.length === 0 || samples.length > 48000 * 20) return false;
  try {
    const tmp = path.join(dataDir, 'clip.tmp');
    fs.writeFileSync(tmp, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    fs.renameSync(tmp, path.join(dataDir, 'clip.pcm'));
    return true;
  } catch {
    return false;
  }
});

/* ───── UwUpad catalogue ─────
 * The window never talks to the network itself; these handlers do, and only to this one site.
 * Requests happen when the user searches, scrolls or presses a button — nothing is crawled. */
const UWU_SITE = 'https://uwupad.me';
const UWU_CDN = 'https://cdn.uwupad.me';
const uwuHeaders = () => ({ Accept: 'application/json', 'User-Agent': `AuraVoice/${app.getVersion()} (desktop soundboard)` });
const uwuExt = /^(mp3|wav|ogg|m4a|flac|opus)$/;
const uwuCache = new Map(); // recently fetched audio, so "listen, then add" downloads once

ipcMain.handle('uwu:list', async (_e, q) => {
  const feed = ['popular', 'trending', 'latest'].includes(q?.feed) ? q.feed : 'popular';
  const query = typeof q?.query === 'string' ? q.query.trim().slice(0, 80) : '';
  const offset = Math.max(0, Math.min(5000, Number(q?.offset) || 0));
  const url = query
    ? `${UWU_SITE}/api/search?v3=true&query=${encodeURIComponent(query)}&limit=24&offset=${offset}`
    : `${UWU_SITE}/api/sounds/?v3=true&tab=${feed}&limit=24&offset=${offset}`;
  try {
    const res = await fetch(url, { headers: uwuHeaders(), signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { error: true };
    const json = await res.json();
    const items = (Array.isArray(json?.data) ? json.data : [])
      .slice(0, 24)
      .map((s) => ({
        id: Number(s.id),
        file: Number(s.original_id || s.id), // re-uploads point at the original file
        ext: String(s.extension || 'mp3').toLowerCase(),
        title: (String(s.title || '').trim() || 'Без названия').slice(0, 80),
        duration: Math.round(Number(s.duration) || 0),
        likes: Number(s.likes) || 0,
        explicit: !!s.is_explicit,
        loud: !!s.is_loud,
      }))
      .filter((s) => Number.isInteger(s.id) && Number.isInteger(s.file) && s.file > 0 && uwuExt.test(s.ext));
    return { total: Number(json.total) || items.length, items };
  } catch {
    return { error: true };
  }
});

async function uwuAudio(item) {
  const file = Number(item?.file);
  const ext = String(item?.ext || '');
  if (!Number.isInteger(file) || file <= 0 || !uwuExt.test(ext)) return null;
  const key = `${file}.${ext}`;
  if (uwuCache.has(key)) return uwuCache.get(key);
  try {
    const res = await fetch(`${UWU_CDN}/${key}`, { headers: { 'User-Agent': uwuHeaders()['User-Agent'] }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!bytes.length || bytes.length > 15e6) return null;
    uwuCache.set(key, bytes);
    if (uwuCache.size > 30) uwuCache.delete(uwuCache.keys().next().value);
    return bytes;
  } catch {
    return null;
  }
}
ipcMain.handle('uwu:sound', (_e, item) => uwuAudio(item));
ipcMain.handle('uwu:add', async (_e, item) => {
  const bytes = await uwuAudio(item);
  if (!bytes) return null;
  try {
    fs.mkdirSync(soundsDir(), { recursive: true });
    const id = `${crypto.randomUUID()}.${item.ext}`;
    fs.writeFileSync(path.join(soundsDir(), id), bytes);
    return { id, name: (String(item.title || '').trim() || 'Звук').slice(0, 40), source: `uwu:${Number(item.id)}` };
  } catch {
    return null;
  }
});
ipcMain.handle('uwu:open', () => shell.openExternal(UWU_SITE));

/* ───── Hotkeys ─────
 * The window owns the configuration and re-sends all of it on every change. */
const accelOk = (a) => typeof a === 'string' && /^((Ctrl|Alt|Shift)\+){0,3}([A-Z0-9]|F\d{1,2}|num\d|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert)$/.test(a);
ipcMain.handle('hotkeys:set', (_e, config) => {
  if (devRun) return [];
  globalShortcut.unregisterAll();
  const failed = [];
  const used = new Set();
  const bind = (accel, action) => {
    if (!accelOk(accel) || used.has(accel)) return;
    used.add(accel);
    let ok = false;
    try {
      ok = globalShortcut.register(accel, action);
    } catch {}
    if (!ok) failed.push(accel); // some other program already owns this combination
  };
  hotkeys = { power: accelOk(config?.power) ? config.power : '', mute: accelOk(config?.mute) ? config.mute : '' };
  bind(hotkeys.power, () => command('power'));
  bind(hotkeys.mute, () => command('mute'));
  // Ready voices with a key of their own; pressing the key again returns to the normal voice.
  for (const [id, accel] of Array.isArray(config?.voices) ? config.voices.slice(0, 40) : []) {
    if (typeof id === 'string' && /^[a-z]{2,20}$/.test(id)) bind(accel, () => command('voice', id));
  }
  const pads = Array.isArray(config?.pads) ? config.pads.slice(0, 200) : [];
  pads.forEach((key, i) => key && bind(key, () => command('pad', i)));
  // Pads without a key of their own: the first nine get Ctrl+Alt+digit.
  pads.forEach((key, i) => !key && i < 9 && bind(`Ctrl+Alt+${i + 1}`, () => command('pad', i)));
  refreshTray();
  return failed;
});

/* ───── Microphones the module can live in ───── */
ipcMain.handle('system:devices', () => {
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    "$current = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Aura' -ErrorAction SilentlyContinue).Device",
    "Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture' | ForEach-Object {",
    '  if ((Get-ItemProperty $_.PSPath).DeviceState -eq 1) {',
    "    $p = Get-ItemProperty ($_.PSPath + '\\Properties')",
    "    [pscustomobject]@{ guid = $_.PSChildName; name = ($p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2' + ' — ' + $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'); current = ($_.PSChildName -eq $current) }",
    '  }',
    '} | ConvertTo-Json -Compress',
  ].join('\n');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' }, (err, out) => {
      try {
        const parsed = JSON.parse(String(out).trim() || '[]');
        resolve(
          (Array.isArray(parsed) ? parsed : [parsed])
            .filter((d) => /^\{[0-9a-fA-F-]{36}\}$/.test(d.guid))
            .map((d) => ({ guid: d.guid, name: String(d.name).slice(0, 90), current: !!d.current }))
        );
      } catch {
        resolve([]);
      }
    });
  });
});

/* ───── Preset files ───── */
const presetFilter = [{ name: 'Пресет Aura', extensions: ['json'] }];
ipcMain.handle('preset:export', async (_e, preset) => {
  if (!preset || typeof preset !== 'object' || typeof preset.v !== 'object') return false;
  const safeName = String(preset.name || 'preset').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40) || 'preset';
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Сохранить пресет', defaultPath: `${safeName}.aura.json`, filters: presetFilter });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify({ app: 'aura', version: 1, name: String(preset.name || ''), v: preset.v }, null, 2));
  return true;
});
ipcMain.handle('preset:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Загрузить пресет', filters: presetFilter, properties: ['openFile'] });
  if (canceled || !filePaths[0]) return null;
  try {
    if (fs.statSync(filePaths[0]).size > 20000) return { error: true };
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (data?.app !== 'aura' || !data.v || typeof data.v !== 'object') return { error: true };
    return { name: String(data.name || ''), v: data.v };
  } catch {
    return { error: true };
  }
});

/* ───── Tray ───── */
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
const command = (name, arg) => win?.webContents.send('tray:command', name, arg);

function refreshTray() {
  if (!tray) return;
  tray.setImage(asset(ui.on && !ui.mute ? 'tray.png' : 'tray-off.png'));
  tray.setToolTip(ui.mute ? 'Aura — микрофон заглушён' : ui.on ? `Aura — ${ui.presetName}` : 'Aura — выключено');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Открыть Aura', click: showWindow },
      { type: 'separator' },
      { label: 'Обработка голоса', type: 'checkbox', checked: ui.on, accelerator: hotkeys.power || undefined, registerAccelerator: false, click: () => command('power') },
      { label: 'Заглушить микрофон', type: 'checkbox', checked: ui.mute, enabled: ui.system, accelerator: hotkeys.mute || undefined, registerAccelerator: false, click: () => command('mute') },
      {
        label: 'Характер',
        enabled: ui.presets.length > 0,
        submenu: ui.presets.map((p) => ({ label: p.name, type: 'radio', checked: p.id === ui.preset, click: () => command('preset', p.id) })),
      },
      {
        label: 'Эффект',
        enabled: ui.voices.length > 0,
        submenu: ui.voices.map((v) => ({ label: v.name, type: 'radio', checked: v.id === ui.voice, click: () => command('voice', v.id === ui.voice ? 'none' : v.id) })),
      },
      { type: 'separator' },
      {
        label: 'Запускать вместе с Windows',
        type: 'checkbox',
        enabled: app.isPackaged, // only meaningful for the installed app
        checked: app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      { type: 'separator' },
      {
        label: 'Выйти',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  tray = new Tray(asset('tray-off.png'));
  tray.on('click', showWindow);
  refreshTray();
}

ipcMain.on('ui:state', (_e, state) => {
  if (!state || typeof state !== 'object') return;
  ui = {
    on: !!state.on,
    mute: !!state.mute,
    system: !!state.system,
    preset: String(state.preset || ''),
    presetName: String(state.presetName || ''),
    presets: Array.isArray(state.presets) ? state.presets.slice(0, 20).map((p) => ({ id: String(p.id), name: String(p.name) })) : [],
    voice: String(state.voice || 'none'),
    voices: Array.isArray(state.voices) ? state.voices.slice(0, 40).map((v) => ({ id: String(v.id), name: String(v.name) })) : [],
  };
  refreshTray();
});

/* ───── System module (APO) ───── */
const dataDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Aura');
const binDir = app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin');
const installedDll = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Aura', 'AuraAPO.dll');

// The module's live meters: status.txt is rewritten ~8 times a second while it runs.
ipcMain.handle('system:levels', () => {
  try {
    const file = path.join(dataDir, 'status.txt');
    if (Date.now() - fs.statSync(file).mtimeMs > 1500) return null;
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = Number(line.slice(eq + 1));
    }
    return out;
  } catch {
    return null;
  }
});

// Windows and driver updates can wipe a microphone's effect slot. The DLL is then still on disk
// but nothing runs it; notice that, so the window can offer to attach it again.
let attached = null; // unknown until the first check
function checkAttached() {
  const reg = (args) => new Promise((resolve) => execFile('reg.exe', ['query', ...args], { windowsHide: true }, (err, out) => resolve(err ? '' : out)));
  return reg(['HKLM\\SOFTWARE\\Aura', '/v', 'Device', '/reg:64']).then(async (out) => {
    const guid = /\{[0-9a-fA-F-]{36}\}/.exec(out)?.[0];
    if (!guid) return (attached = null);
    const slot = await reg([`HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Capture\\${guid}\\FxProperties`, '/v', '{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2', '/reg:64']);
    attached = /7C1D5A62-3F0E-4B7A-9E2B-A0D3C4F51E88/i.test(slot);
  });
}

// Picking the high-quality engine again clears the "it crashed last time" marker the module leaves behind.
ipcMain.handle('system:reset-deep', () => {
  try {
    fs.rmSync(path.join(dataDir, 'deep.loading'), { force: true });
  } catch {}
  return true;
});

ipcMain.handle('system:status', () => {
  const status = {
    available: fs.existsSync(path.join(binDir, 'AuraSetup.exe')) && fs.existsSync(path.join(binDir, 'AuraAPO.dll')),
    installed: fs.existsSync(installedDll),
    visible: !!win && win.isVisible() && !win.isMinimized(),
    alive: false,
  };
  status.detached = status.installed && attached === false;
  try {
    // The module rewrites status.txt once a second while Windows is running it.
    status.alive = Date.now() - fs.statSync(path.join(dataDir, 'status.txt')).mtimeMs < 3000;
  } catch {}
  return status;
});

ipcMain.handle('system:write', (_e, text) => {
  if (devRun && !probeMode) return false; // a screenshot run must not change what the live module is doing
  if (typeof text !== 'string' || text.length > 2000) return false;
  try {
    // Write-then-rename, so the module never reads a half-written file.
    const tmp = path.join(dataDir, 'settings.tmp');
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, path.join(dataDir, 'settings.txt'));
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('system:setup', (_e, action, unprotect, device) => {
  if (action !== 'install' && action !== 'uninstall') return { ok: false, lines: [] };
  const log = path.join(dataDir, 'setup.log');
  try { fs.rmSync(log, { force: true }); } catch {}
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const guid = typeof device === 'string' && /^\{[0-9a-fA-F-]{36}\}$/.test(device) ? device : null;
  const args = action === 'install' ? ["'install'", ...(unprotect ? ["'--unprotect'"] : []), ...(guid ? ["'--device'", quote(guid)] : [])].join(',') : quote(action);
  const command = `Start-Process -FilePath ${quote(path.join(binDir, 'AuraSetup.exe'))} -ArgumentList ${args} -Verb RunAs -Wait -WindowStyle Hidden`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err) => {
      let lines = [];
      try { lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch {}
      const ok = lines[0] === 'result=ok';
      checkAttached();
      resolve({ ok, cancelled: !!err && !lines.length, lines: lines.slice(1).filter((l) => !l.startsWith('device=')) });
    });
  });
});

app.whenReady().then(() => {
  // Only our own local page is ever loaded, so microphone / output selection is granted.
  const allowed = new Set(['media', 'speaker-selection', 'audioCapture']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
  createWindow();
  checkAttached();
  setInterval(checkAttached, 60000);
  if (!devRun) {
    createTray();
    // Work from inside a game, without alt-tabbing to the window.
    globalShortcut.register(HOTKEY_POWER, () => command('power'));
    globalShortcut.register(HOTKEY_MUTE, () => command('mute'));
    // Soundpad-style: the first nine pads from anywhere.
    for (let i = 0; i < 9; i++) globalShortcut.register(`Ctrl+Alt+${i + 1}`, () => command('pad', i));
  }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => app.quit());

const { app, BrowserWindow, session, ipcMain, Tray, Menu, globalShortcut, dialog } = require('electron');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Dev-only flags: --shot=<png> saves a screenshot and quits, --test runs the DSP self-check.
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const testMode = process.argv.includes('--test');
const probeMode = process.argv.includes('--probe'); // dev: switch on for one run without saving
const devRun = !!shotArg || testMode || probeMode;
const startHidden = process.argv.includes('--hidden'); // launched with Windows: straight to the tray
const asset = (name) => path.join(__dirname, 'assets', name);

// Let the audio engine start on launch, without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!devRun && !app.requestSingleInstanceLock()) app.quit();

let win;
let tray;
let quitting = false;
let ui = { on: false, mute: false, system: false, preset: '', presetName: '', presets: [] }; // what the window last reported
const HOTKEY_POWER = 'Ctrl+Shift+F9';
const HOTKEY_MUTE = 'Ctrl+Shift+F10';

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 900,
    minWidth: 940,
    minHeight: 700,
    show: false,
    backgroundColor: '#09090d',
    title: 'Aura',
    icon: asset('icon.ico'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 44 },
    webPreferences: {
      // The voice must keep flowing while the window is minimised.
      backgroundThrottling: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, 'app', 'index.html'), {
    query: testMode ? { test: '1' } : probeMode ? { probe: '1' } : {},
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win.show();
  });

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
    win.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.message);
    });
    setTimeout(async () => {
      if (shotArg) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shotArg.slice('--shot='.length), img.toPNG());
      }
      app.quit();
    }, probeMode ? 10000 : 4500);
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
      { label: 'Обработка голоса', type: 'checkbox', checked: ui.on, accelerator: HOTKEY_POWER, registerAccelerator: false, click: () => command('power') },
      { label: 'Заглушить микрофон', type: 'checkbox', checked: ui.mute, enabled: ui.system, accelerator: HOTKEY_MUTE, registerAccelerator: false, click: () => command('mute') },
      {
        label: 'Характер',
        enabled: ui.presets.length > 0,
        submenu: ui.presets.map((p) => ({ label: p.name, type: 'radio', checked: p.id === ui.preset, click: () => command('preset', p.id) })),
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

ipcMain.handle('system:setup', (_e, action, unprotect) => {
  if (action !== 'install' && action !== 'uninstall') return { ok: false, lines: [] };
  const log = path.join(dataDir, 'setup.log');
  try { fs.rmSync(log, { force: true }); } catch {}
  const quote = (v) => `'${v.replace(/'/g, "''")}'`;
  const args = action === 'install' && unprotect ? "'install','--unprotect'" : quote(action);
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
  }
});

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => app.quit());

const { app, BrowserWindow, session, ipcMain } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// Dev-only flags: --shot=<png> saves a screenshot and quits, --test runs the DSP self-check.
const shotArg = process.argv.find((a) => a.startsWith('--shot='));
const testMode = process.argv.includes('--test');

// Let the audio engine start on launch, without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (!app.requestSingleInstanceLock()) app.quit();

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 820,
    minWidth: 940,
    minHeight: 700,
    show: false,
    backgroundColor: '#09090d',
    title: 'Aura',
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
    query: testMode ? { test: '1' } : {},
  });
  win.once('ready-to-show', () => win.show());

  if (shotArg || testMode) {
    win.webContents.on('console-message', (e) => {
      console.log('[renderer]', e.message);
    });
    setTimeout(async () => {
      if (shotArg) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(shotArg.slice('--shot='.length), img.toPNG());
      }
      app.quit();
    }, 4500);
  }
}

/* ───── System module (APO) ───── */
const dataDir = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Aura');
const binDir = path.join(__dirname, 'native', 'bin');
const installedDll = path.join(process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files', 'Aura', 'AuraAPO.dll');

ipcMain.handle('system:status', () => {
  const status = {
    available: fs.existsSync(path.join(binDir, 'AuraSetup.exe')) && fs.existsSync(path.join(binDir, 'AuraAPO.dll')),
    installed: fs.existsSync(installedDll),
    alive: false,
  };
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
});

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.on('window-all-closed', () => app.quit());

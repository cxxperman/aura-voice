// A one-off check for the party idea: does nekto.me's voice chat work inside an Electron window?
// The site is loaded exactly as it is: nothing is injected into the page, nothing about the
// browser is disguised (the user agent says Electron). The only permission it gets is the
// microphone, and only on nekto.me. Run:  npx electron scripts/nekto-probe.js
const { app, BrowserWindow, session } = require('electron');
const path = require('path');

app.setPath('userData', path.join(app.getPath('temp'), 'aura-nekto-probe')); // its own profile, apart from Aura's

app.whenReady().then(() => {
  const ses = session.fromPartition('persist:nekto-probe');
  const allowed = (url) => {
    try {
      const host = new URL(url).hostname;
      return host === 'nekto.me' || host.endsWith('.nekto.me');
    } catch {
      return false;
    }
  };
  ses.setPermissionRequestHandler((wc, permission, done, details) => done(permission === 'media' && allowed(details.requestingUrl || wc.getURL())));
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && allowed(origin));

  const win = new BrowserWindow({
    width: 1100,
    height: 820,
    title: 'Aura — проверка nekto.me',
    backgroundColor: '#111114',
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // links stay inside or go nowhere
  console.log('user agent the site sees:', win.webContents.getUserAgent());
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('page:', String(message).slice(0, 200)); // warnings and errors only
  });
  win.loadURL('https://nekto.me/audiochat');
});
app.on('window-all-closed', () => app.quit());

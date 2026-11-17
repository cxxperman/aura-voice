const { app, BrowserWindow, session, ipcMain, Tray, Menu, globalShortcut, dialog, shell, nativeTheme, net } = require('electron');
const { execFile, spawn } = require('child_process');
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
  nativeTheme.themeSource = 'dark'; // Aura is a dark room whatever Windows is set to: its light needs darkness behind it
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
    titleBarOverlay: { color: '#00000000', symbolColor: '#ffffff', height: 30 },
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
// Clownfish keeps the sounds of its player as plain files in its own folder: copy them over, so
// someone moving from it finds their sounds here. Returns null when Clownfish is not installed.
ipcMain.handle('sounds:clownfish', () => {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean).map((p) => path.join(p, 'ClownfishVoiceChanger', 'sounds'));
  const dir = roots.find((p) => fs.existsSync(p));
  if (!dir) return null;
  fs.mkdirSync(soundsDir(), { recursive: true });
  const added = [];
  for (const name of fs.readdirSync(dir).sort().slice(0, 100)) {
    try {
      const ext = path.extname(name).toLowerCase();
      const id = crypto.randomUUID() + ext;
      const file = path.join(dir, name);
      if (!soundId.test(id) || !fs.statSync(file).isFile() || fs.statSync(file).size > 30e6) continue;
      fs.copyFileSync(file, path.join(soundsDir(), id));
      added.push({ id, name: path.basename(name, path.extname(name)).slice(0, 40), source: 'clownfish' });
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

/* ───── Rendering recordings through the module's own chain (native/render.cpp) ─────
 * The page decodes audio (only it has a decoder) and hands over mono float32 at 48 kHz; the tool
 * returns stereo. A short sample comes straight back; a file is streamed to disk as a WAV. */
const renderTool = () => path.join(app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(__dirname, 'native', 'bin'), 'AuraRender.exe');
const renderModel = () => path.join(path.dirname(renderTool()), 'DeepFilterNet3_onnx.tar.gz');
const renderDir = () => {
  const dir = path.join(app.getPath('temp'), 'aura-render');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const cleanSettings = (text) => String(text || '').split(/\r?\n/).filter((l) => /^[a-z0-9]{1,16}=-?[0-9.]{1,12}$/.test(l)).slice(0, 200).join('\n') + '\n';
function runRender(inFile, outFile, settings) {
  return new Promise((resolve) => {
    const cfg = inFile + '.txt';
    fs.writeFileSync(cfg, cleanSettings(settings));
    const args = [inFile, outFile, cfg];
    if (fs.existsSync(renderModel())) args.push(renderModel());
    execFile(renderTool(), args, { windowsHide: true, timeout: 20 * 60 * 1000 }, (err) => {
      fs.rm(cfg, { force: true }, () => {});
      resolve(!err);
    });
  });
}
let renderSeq = 0;
// The user's own recorded phrase, kept between sessions: the effects page tries voices on it.
const takeFile = () => path.join(app.getPath('userData'), 'take.f32');
ipcMain.handle('take:save', (_e, pcm) => {
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : []);
  if (!bytes.length || bytes.length % 4 || bytes.length > 4 * 48000 * 30) return false;
  try {
    fs.writeFileSync(takeFile(), bytes);
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle('take:load', () => {
  try {
    const b = fs.readFileSync(takeFile());
    return b.length && b.length % 4 === 0 ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null;
  } catch {
    return null;
  }
});
ipcMain.handle('render:available', () => fs.existsSync(renderTool()));
ipcMain.handle('render:sample', async (_e, pcm, settings) => {
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : pcm?.buffer || []);
  if (!bytes.length || bytes.length % 4 || bytes.length > 4 * 48000 * 60 || !fs.existsSync(renderTool())) return null;
  const base = path.join(renderDir(), `sample-${process.pid}-${++renderSeq}`);
  try {
    fs.writeFileSync(base + '.in', bytes);
    if (!(await runRender(base + '.in', base + '.out', settings))) return null;
    const out = fs.readFileSync(base + '.out');
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  } catch {
    return null;
  } finally {
    for (const ext of ['.in', '.out']) fs.rm(base + ext, { force: true }, () => {});
  }
});
// A file: ask where to save first, take the audio in pieces, then render and write the WAV.
const renderJobs = new Map();
ipcMain.handle('render:begin', async (_e, name) => {
  const safe = String(name || 'Aura').replace(/\.[^.]{1,5}$/, '').replace(/[^\p{L}\p{N} _.()-]/gu, '').slice(0, 80) || 'Aura';
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Сохранить запись', defaultPath: `${safe} — Aura.wav`, filters: [{ name: 'WAV', extensions: ['wav'] }] });
  if (canceled || !filePath) return null;
  const token = `${process.pid}-${++renderSeq}`;
  const base = path.join(renderDir(), 'file-' + token);
  renderJobs.set(token, { base, target: filePath, bytes: 0, fd: fs.openSync(base + '.in', 'w') });
  return token;
});
ipcMain.handle('render:chunk', (_e, token, pcm) => {
  const job = renderJobs.get(token);
  const bytes = Buffer.from(pcm instanceof ArrayBuffer ? pcm : pcm?.buffer || []);
  if (!job || bytes.length % 4 || job.bytes + bytes.length > 4 * 48000 * 3600 * 3) return false; // three hours at most
  fs.writeSync(job.fd, bytes);
  job.bytes += bytes.length;
  return true;
});
ipcMain.handle('render:finish', async (_e, token, settings) => {
  const job = renderJobs.get(token);
  if (!job) return { ok: false };
  renderJobs.delete(token);
  fs.closeSync(job.fd);
  const clean = () => { for (const ext of ['.in', '.out']) fs.rm(job.base + ext, { force: true }, () => {}); };
  try {
    if (!job.bytes) return { ok: false };
    const frames = job.bytes / 4;
    let source = job.base + '.in';
    let channels = 1;
    if (settings != null) { // null = already processed (a take recorded through the module): only wrap it
      if (!fs.existsSync(renderTool()) || !(await runRender(source, job.base + '.out', settings))) return { ok: false };
      source = job.base + '.out';
      channels = 2;
    }
    // 24-bit PCM WAV, written in pieces.
    const out = fs.openSync(job.target, 'w');
    const data = frames * channels * 3;
    const head = Buffer.alloc(44);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20); head.writeUInt16LE(channels, 22); head.writeUInt32LE(48000, 24); head.writeUInt32LE(48000 * channels * 3, 28);
    head.writeUInt16LE(channels * 3, 32); head.writeUInt16LE(24, 34); head.write('data', 36); head.writeUInt32LE(data, 40);
    fs.writeSync(out, head);
    const inp = fs.openSync(source, 'r');
    const piece = Buffer.alloc(4 * 65536);
    for (;;) {
      const got = fs.readSync(inp, piece, 0, piece.length, null);
      if (got <= 0) break;
      const n = got >> 2;
      const pcm = Buffer.alloc(n * 3);
      for (let i = 0; i < n; i++) {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(piece.readFloatLE(i * 4) * 8388607)));
        pcm.writeIntLE(v, i * 3, 3);
      }
      fs.writeSync(out, pcm);
    }
    fs.closeSync(inp);
    fs.closeSync(out);
    return { ok: true, seconds: frames / 48000, name: path.basename(job.target) };
  } catch {
    return { ok: false };
  } finally {
    clean();
  }
});

/* ───── Preset files ───── */
const presetFilter = [{ name: 'Пресет Aura', extensions: ['json'] }];
ipcMain.handle('preset:export', async (_e, preset) => {
  if (!preset || typeof preset !== 'object' || typeof preset.v !== 'object') return false;
  const safeName = String(preset.name || 'preset').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 40) || 'preset';
  const { canceled, filePath } = await dialog.showSaveDialog(win, { title: 'Сохранить пресет', defaultPath: `${safeName}.aura.json`, filters: presetFilter });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify({ app: 'aura', version: 2, name: String(preset.name || ''), v: preset.v, eq: preset.eq && typeof preset.eq === 'object' ? preset.eq : {} }, null, 2));
  return true;
});
ipcMain.handle('preset:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { title: 'Загрузить пресет', filters: presetFilter, properties: ['openFile'] });
  if (canceled || !filePaths[0]) return null;
  try {
    if (fs.statSync(filePaths[0]).size > 20000) return { error: true };
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    if (data?.app !== 'aura' || !data.v || typeof data.v !== 'object') return { error: true };
    return { name: String(data.name || ''), v: data.v, eq: data.eq && typeof data.eq === 'object' ? data.eq : {} };
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
        label: 'Готовый звук',
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

// After an update the window is new but the module inside the microphone is still the old file:
// compare the installed one with the one shipped in this version (size first, then contents).
let outdatedMemo = { key: '', value: false };
function moduleOutdated() {
  try {
    const shipped = path.join(binDir, 'AuraAPO.dll');
    const a = fs.statSync(shipped), b = fs.statSync(installedDll);
    const key = `${a.size}:${a.mtimeMs}:${b.size}:${b.mtimeMs}`;
    if (outdatedMemo.key !== key) {
      const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      outdatedMemo = { key, value: a.size !== b.size || hash(shipped) !== hash(installedDll) };
    }
    return outdatedMemo.value;
  } catch {
    return false;
  }
}

/* ───── Updates ─────
 * Releases of the project's own GitHub repository are the only source. The window asks, the
 * user decides; nothing is downloaded or installed without a click. */
const UPDATE_REPO = 'cxxperman/aura-voice';
const newer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
let pendingUpdate = null;
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return null;
  try {
    const res = await net.fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`, { headers: { 'User-Agent': `AuraVoice/${app.getVersion()}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    let best = null;
    for (const rel of await res.json()) {
      if (rel.draft) continue;
      for (const asset of rel.assets || []) {
        const m = /^Aura-Setup-(\d+\.\d+\.\d+)\.exe$/.exec(asset.name || '');
        const url = String(asset.browser_download_url || '');
        if (!m || !url.startsWith(`https://github.com/${UPDATE_REPO}/releases/download/`)) continue;
        if (newer(m[1], app.getVersion()) && (!best || newer(m[1], best.version))) {
          best = { version: m[1], url, size: Number(asset.size) || 0, digest: typeof asset.digest === 'string' ? asset.digest : '' };
        }
      }
    }
    pendingUpdate = best;
    return best ? { version: best.version, megabytes: Math.round(best.size / 1e6) } : null;
  } catch {
    return null;
  }
});
ipcMain.handle('update:install', async () => {
  const u = pendingUpdate;
  if (!u) return false;
  try {
    const res = await net.fetch(u.url, { headers: { 'User-Agent': `AuraVoice/${app.getVersion()}` } });
    if (!res.ok) return false;
    const data = Buffer.from(await res.arrayBuffer());
    // What arrived must be what the release lists: its size, and its SHA-256 when GitHub gives one.
    if (u.size && data.length !== u.size) return false;
    if (u.digest.startsWith('sha256:') && crypto.createHash('sha256').update(data).digest('hex') !== u.digest.slice(7).toLowerCase()) return false;
    const file = path.join(app.getPath('temp'), `Aura-Setup-${u.version}.exe`);
    fs.writeFileSync(file, data);
    spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.exit(0), 300);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('system:status', () => {
  const status = {
    available: fs.existsSync(path.join(binDir, 'AuraSetup.exe')) && fs.existsSync(path.join(binDir, 'AuraAPO.dll')),
    installed: fs.existsSync(installedDll),
    visible: !!win && win.isVisible() && !win.isMinimized(),
    alive: false,
  };
  status.detached = status.installed && attached === false;
  status.outdated = status.installed && moduleOutdated();
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

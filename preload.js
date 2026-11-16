const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the main process for: the state of the system module,
// saving its settings, and running the installer (which shows a Windows admin prompt).
contextBridge.exposeInMainWorld('auraSystem', {
  status: () => ipcRenderer.invoke('system:status'),
  levels: () => ipcRenderer.invoke('system:levels'),
  resetDeep: () => ipcRenderer.invoke('system:reset-deep'),
  exportPreset: (preset) => ipcRenderer.invoke('preset:export', preset),
  importPreset: () => ipcRenderer.invoke('preset:import'),
  write: (text) => ipcRenderer.invoke('system:write', text),
  setup: (action, unprotect) => ipcRenderer.invoke('system:setup', action, !!unprotect),
  // Tray menu <-> window
  report: (state) => ipcRenderer.send('ui:state', state),
  onCommand: (handler) => ipcRenderer.on('tray:command', (_e, name, arg) => handler(name, arg)),
});

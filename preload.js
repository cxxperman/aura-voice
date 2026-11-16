const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the main process for: the state of the system module,
// saving its settings, and running the installer (which shows a Windows admin prompt).
contextBridge.exposeInMainWorld('auraSystem', {
  status: () => ipcRenderer.invoke('system:status'),
  levels: () => ipcRenderer.invoke('system:levels'),
  resetDeep: () => ipcRenderer.invoke('system:reset-deep'),
  // Soundboard
  addSounds: () => ipcRenderer.invoke('sounds:add'),
  readSound: (id) => ipcRenderer.invoke('sounds:read', id),
  removeSound: (id) => ipcRenderer.invoke('sounds:remove', id),
  writeClip: (samples) => ipcRenderer.invoke('sounds:clip', samples),
  // UwUpad catalogue
  catalog: (query) => ipcRenderer.invoke('uwu:list', query),
  catalogSound: (item) => ipcRenderer.invoke('uwu:sound', item),
  catalogAdd: (item) => ipcRenderer.invoke('uwu:add', item),
  openCatalogSite: () => ipcRenderer.invoke('uwu:open'),
  exportPreset: (preset) => ipcRenderer.invoke('preset:export', preset),
  importPreset: () => ipcRenderer.invoke('preset:import'),
  write: (text) => ipcRenderer.invoke('system:write', text),
  setup: (action, unprotect, device) => ipcRenderer.invoke('system:setup', action, !!unprotect, device),
  captureDevices: () => ipcRenderer.invoke('system:devices'),
  setHotkeys: (config) => ipcRenderer.invoke('hotkeys:set', config),
  // Tray menu <-> window
  report: (state) => ipcRenderer.send('ui:state', state),
  onCommand: (handler) => ipcRenderer.on('tray:command', (_e, name, arg) => handler(name, arg)),
});

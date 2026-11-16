const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the main process for: the state of the system module,
// saving its settings, and running the installer (which shows a Windows admin prompt).
contextBridge.exposeInMainWorld('auraSystem', {
  status: () => ipcRenderer.invoke('system:status'),
  write: (text) => ipcRenderer.invoke('system:write', text),
  setup: (action, unprotect) => ipcRenderer.invoke('system:setup', action, !!unprotect),
});

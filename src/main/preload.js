'use strict';
// Sandboxed preload: the only bridge between the UI and the main process.
// Exposes a small, fixed API; the renderer gets no Node.js access.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  rpc: (method, args) => ipcRenderer.invoke('rpc', method, args || []),
  exportFile: (kind) => ipcRenderer.invoke('export:file', kind),
  pickImport: () => ipcRenderer.invoke('import:pick'),
  openDataFolder: () => ipcRenderer.invoke('shell:open-data-folder'),
  showFile: (file) => ipcRenderer.invoke('shell:show-file', file),
  setNativeTheme: (theme) => ipcRenderer.send('theme:set', theme),
  onCloseRequested: (callback) => {
    ipcRenderer.on('app:close-requested', () => callback());
  },
  respondToClose: (canClose) => ipcRenderer.send('app:close-response', !!canClose)
});

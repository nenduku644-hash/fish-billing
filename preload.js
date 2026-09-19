const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  printInvoice: () => ipcRenderer.send('print-invoice'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  saveFastCache: (key, data) => ipcRenderer.invoke('fast-save-cache', { key, data }),
  readFastCache: (key) => ipcRenderer.invoke('fast-read-cache', { key })
});

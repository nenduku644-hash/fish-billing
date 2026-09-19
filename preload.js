const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  printInvoice: () => ipcRenderer.send('print-invoice'),
  openExternal: (url) => ipcRenderer.send('open-external', url)
});

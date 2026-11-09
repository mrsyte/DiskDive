'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('diskdive', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scan: (target) => ipcRenderer.invoke('scan', target),
  reveal: (filePath) => ipcRenderer.invoke('reveal', filePath),
  onProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('scan-progress', handler);
    return () => ipcRenderer.removeListener('scan-progress', handler);
  },
});

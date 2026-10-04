const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  invoke: (channel, ...args) => ipcRenderer.invoke('qa:invoke', channel, ...args),
  on: (channel, listener) => { const wrapped = (_, value) => listener(value); ipcRenderer.on('qa:push:'+channel, wrapped); return () => ipcRenderer.removeListener('qa:push:'+channel, wrapped); },
});

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  state: () => ipcRenderer.invoke('wallet:state'),
  setNetwork: (network) => ipcRenderer.invoke('wallet:network', { network }),
  unlock: (privateKey) => ipcRenderer.invoke('wallet:unlock', { privateKey }),
  lock: () => ipcRenderer.invoke('wallet:lock'),
  balances: () => ipcRenderer.invoke('wallet:balances'),
  estimate: (payload) => ipcRenderer.invoke('wallet:estimate', payload),
  send: (payload) => ipcRenderer.invoke('wallet:send', payload),
  records: () => ipcRenderer.invoke('records:list'),
  exportRecords: () => ipcRenderer.invoke('records:export'),
});

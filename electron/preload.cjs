const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('batchAudioDesktop', {
  bridgeUrl: () => ipcRenderer.invoke('bridge:get-url'),
  bridgeAuthToken: () => ipcRenderer.invoke('bridge:get-auth-token'),
  bridgeStatus: () => ipcRenderer.invoke('bridge:get-status'),
  chooseAudioFile: () => ipcRenderer.invoke('dialog:open-audio'),
  chooseExportPath: () => ipcRenderer.invoke('dialog:save-wav'),
})

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ditto', {
  status: () => ipcRenderer.invoke('ditto:status'),
  scan: () => ipcRenderer.invoke('ditto:scan'),
  search: query => ipcRenderer.invoke('ditto:search', query),
  chooseRoot: () => ipcRenderer.invoke('ditto:choose-root'),
  removeRoot: root => ipcRenderer.invoke('ditto:remove-root', root),
  chooseWorkspace: () => ipcRenderer.invoke('ditto:choose-workspace'),
  exportBundle: () => ipcRenderer.invoke('ditto:export'),
  linkStart: () => ipcRenderer.invoke('ditto:link-start'),
  linkPoll: () => ipcRenderer.invoke('ditto:link-poll'),
  signOut: () => ipcRenderer.invoke('ditto:sign-out'),
  piLogin: () => ipcRenderer.invoke('ditto:pi-login'),
  chat: question => ipcRenderer.invoke('ditto:chat', question),
  cancelChat: () => ipcRenderer.invoke('ditto:cancel-chat'),
  onProgress: listener => { ipcRenderer.on('ditto:progress', (_event, message) => listener(message)); },
  onScanFinished: listener => { ipcRenderer.on('ditto:scan-finished', (_event, result) => listener(result)); },
  onChatEvent: listener => { ipcRenderer.on('ditto:chat-event', (_event, event) => listener(event)); },
});

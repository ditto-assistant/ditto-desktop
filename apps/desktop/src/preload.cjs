const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ditto", {
  status: () => ipcRenderer.invoke("ditto:status"),
  scan: () => ipcRenderer.invoke("ditto:scan"),
  search: (query) => ipcRenderer.invoke("ditto:search", query),
  chooseRoot: () => ipcRenderer.invoke("ditto:choose-root"),
  removeRoot: (root) => ipcRenderer.invoke("ditto:remove-root", root),
  chooseWorkspace: () => ipcRenderer.invoke("ditto:choose-workspace"),
  workspace: () => ipcRenderer.invoke("ditto:workspace"),
  defaultWorkspace: () => ipcRenderer.invoke("ditto:default-workspace"),
  exportBundle: () => ipcRenderer.invoke("ditto:export"),
  linkStart: () => ipcRenderer.invoke("ditto:link-start"),
  linkCancel: () => ipcRenderer.invoke("ditto:link-cancel"),
  linkPoll: () => ipcRenderer.invoke("ditto:link-poll"),
  signOut: () => ipcRenderer.invoke("ditto:sign-out"),
  piLogin: () => ipcRenderer.invoke("ditto:pi-login"),
  chat: (question, sessionId) => ipcRenderer.invoke("ditto:chat", question, sessionId),
  providerStatus: () => ipcRenderer.invoke("ditto:provider-status"),
  providerLogin: (provider) => ipcRenderer.invoke("ditto:provider-login", provider),
  runProvider: (provider, question, sessionId) =>
    ipcRenderer.invoke("ditto:run-provider", provider, question, sessionId),
  recentRuns: () => ipcRenderer.invoke("ditto:recent-runs"),
  remoteStatus: () => ipcRenderer.invoke("ditto:remote-status"),
  remoteStart: (provider, endpoint) => ipcRenderer.invoke("ditto:remote-start", provider, endpoint),
  remoteStop: () => ipcRenderer.invoke("ditto:remote-stop"),
  remoteHosts: () => ipcRenderer.invoke("ditto:remote-hosts"),
  devicesStatus: () => ipcRenderer.invoke("ditto:devices-status"),
  devicesStart: () => ipcRenderer.invoke("ditto:devices-start"),
  devicesStop: () => ipcRenderer.invoke("ditto:devices-stop"),
  devicesPairCode: () => ipcRenderer.invoke("ditto:devices-pair-code"),
  devicesClaim: (code) => ipcRenderer.invoke("ditto:devices-claim", code),
  devicesUnpair: (peer) => ipcRenderer.invoke("ditto:devices-unpair", peer),
  devicesRequest: (peer, method, params) =>
    ipcRenderer.invoke("ditto:devices-request", peer, method, params),
  enginesStatus: () => ipcRenderer.invoke("ditto:engines-status"),
  enginesUpdate: (provider) => ipcRenderer.invoke("ditto:engines-update", provider),
  onDevicesStatus: (listener) => {
    ipcRenderer.on("ditto:devices-status", (_event, status) => listener(status));
  },
  onEngineUpdate: (listener) => {
    ipcRenderer.on("ditto:engine-update", (_event, status) => listener(status));
  },
  remoteEndpoints: () => ipcRenderer.invoke("ditto:remote-endpoints"),
  teleportPlan: () => ipcRenderer.invoke("ditto:teleport-plan"),
  teleportList: () => ipcRenderer.invoke("ditto:teleport-list"),
  teleportPush: (launchCloud, endpoint) =>
    ipcRenderer.invoke("ditto:teleport-push", launchCloud, endpoint),
  chatSyncStatus: (uid) => ipcRenderer.invoke("ditto:chat-sync-status", uid),
  chatSyncSelect: (uid, provider, id, enabled) =>
    ipcRenderer.invoke("ditto:chat-sync-select", uid, provider, id, enabled),
  chatSyncPrepare: (uid) => ipcRenderer.invoke("ditto:chat-sync-prepare", uid),
  chatSyncRegistered: (uid, key, receipt) =>
    ipcRenderer.invoke("ditto:chat-sync-registered", uid, key, receipt),
  chatSyncAck: (uid, key, receipt) => ipcRenderer.invoke("ditto:chat-sync-ack", uid, key, receipt),
  chatSyncPaused: (uid, key) => ipcRenderer.invoke("ditto:chat-sync-paused", uid, key),
  chatSyncFailed: (uid, key) => ipcRenderer.invoke("ditto:chat-sync-failed", uid, key),
  channelStatus: (service) => ipcRenderer.invoke("ditto:channel-status", service),
  onChannelEvent: (listener) => {
    const handler = (_event, event) => listener(event);
    ipcRenderer.on("ditto:channel-event", handler);
    return () => ipcRenderer.removeListener("ditto:channel-event", handler);
  },
  messagesSettings: () => ipcRenderer.invoke("ditto:messages-settings"),
  channelCancelLogin: (service) => ipcRenderer.invoke("ditto:channel-cancel-login", service),
  channelLogin: (service, method) => ipcRenderer.invoke("ditto:channel-login", service, method),
  channelLogout: (service) => ipcRenderer.invoke("ditto:channel-logout", service),
  channelConversations: (service) => ipcRenderer.invoke("ditto:channel-conversations", service),
  channelMessages: (service, conversationId, limit) =>
    ipcRenderer.invoke("ditto:channel-messages", service, conversationId, limit),
  channelSend: (service, conversationId, content, handle) =>
    ipcRenderer.invoke("ditto:channel-send", service, conversationId, content, handle),
  createPacket: (service, conversationId) =>
    ipcRenderer.invoke("ditto:create-packet", service, conversationId),
  cancelChat: () => ipcRenderer.invoke("ditto:cancel-chat"),
  onProgress: (listener) => {
    ipcRenderer.on("ditto:progress", (_event, message) => listener(message));
  },
  onScanFinished: (listener) => {
    ipcRenderer.on("ditto:scan-finished", (_event, result) => listener(result));
  },
  onProviderEvent: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("ditto:provider-event", wrapped);
    return () => ipcRenderer.removeListener("ditto:provider-event", wrapped);
  },
  onChatEvent: (listener) => {
    ipcRenderer.on("ditto:chat-event", (_event, event) => listener(event));
  },
  onRemoteStatus: (listener) => {
    ipcRenderer.on("ditto:remote-status", (_event, event) => listener(event));
  },
  onTeleportProgress: (listener) => {
    ipcRenderer.on("ditto:teleport-progress", (_event, event) => listener(event));
  },
  browserStatus: () => ipcRenderer.invoke("ditto:browser-status"),
  browserShow: (bounds) => ipcRenderer.invoke("ditto:browser-show", bounds),
  browserHide: () => ipcRenderer.invoke("ditto:browser-hide"),
  browserNavigate: (url) => ipcRenderer.invoke("ditto:browser-navigate", url),
  browserBack: () => ipcRenderer.invoke("ditto:browser-back"),
  browserForward: () => ipcRenderer.invoke("ditto:browser-forward"),
  browserReload: () => ipcRenderer.invoke("ditto:browser-reload"),
  browserSnapshot: () => ipcRenderer.invoke("ditto:browser-snapshot"),
  browserClick: (ref) => ipcRenderer.invoke("ditto:browser-click", ref),
  browserFill: (ref, value) => ipcRenderer.invoke("ditto:browser-fill", ref, value),
  onBrowserState: (listener) => {
    ipcRenderer.on("ditto:browser-state", (_event, event) => listener(event));
  },
  onBrowserOpen: (listener) => {
    ipcRenderer.on("ditto:browser-open", () => listener());
  },
  computerStatus: () => ipcRenderer.invoke("ditto:computer-status"),
  computerSettings: () => ipcRenderer.invoke("ditto:computer-settings"),
  computerEnable: (enabled) => ipcRenderer.invoke("ditto:computer-enable", enabled),
  onComputerEnabled: (listener) => {
    ipcRenderer.on("ditto:computer-enabled", (_event, enabled) => listener(enabled));
  },
});

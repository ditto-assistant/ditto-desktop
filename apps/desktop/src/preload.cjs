const { contextBridge, ipcRenderer } = require("electron");

let computerLease = "";
ipcRenderer.on("ditto:computer-cloud", (_event, status) => {
  computerLease = status.leaseID || "";
});
// Token requests can arrive before the signed-in app mounts its responder.
const liveTokenRequests = [];
let liveTokenResponder = null;
ipcRenderer.on("ditto:live-token-request", (_event, id) => {
  if (liveTokenResponder) liveTokenResponder(id);
  else liveTokenRequests.push(id);
});
contextBridge.exposeInMainWorld("ditto", {
  computerLease: () => computerLease,
  onComputerCloud: (listener) => {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("ditto:computer-cloud", handler);
    return () => ipcRenderer.removeListener("ditto:computer-cloud", handler);
  },
  computerCloudLink: (token) => ipcRenderer.invoke("ditto:computer-cloud-link", token),
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
  runProvider: (provider, question) => ipcRenderer.invoke("ditto:run-provider", provider, question),
  recentRuns: () => ipcRenderer.invoke("ditto:recent-runs"),
  codeThreads: () => ipcRenderer.invoke("ditto:code-threads"),
  updateCodeThread: (id, patch) => ipcRenderer.invoke("ditto:code-thread-update", id, patch),
  openCodeThread: (id) => ipcRenderer.invoke("ditto:code-thread-open", id),
  terminalOpen: (key, cols, rows) => ipcRenderer.invoke("ditto:terminal-open", key, cols, rows),
  terminalWrite: (key, data) => ipcRenderer.invoke("ditto:terminal-write", key, data),
  terminalResize: (key, cols, rows) => ipcRenderer.invoke("ditto:terminal-resize", key, cols, rows),
  terminalClose: (key) => ipcRenderer.invoke("ditto:terminal-close", key),
  onTerminalEvent: (listener) => {
    const handler = (_event, event) => listener(event);
    ipcRenderer.on("ditto:terminal-event", handler);
    return () => ipcRenderer.removeListener("ditto:terminal-event", handler);
  },
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
    const handler = (_event, enabled) => listener(enabled);
    ipcRenderer.on("ditto:computer-enabled", handler);
    return () => ipcRenderer.removeListener("ditto:computer-enabled", handler);
  },
  liveToggle: () => ipcRenderer.invoke("ditto:live-toggle"),
  liveStatus: () => ipcRenderer.invoke("ditto:live-status"),
  // The Ditto window's live shim reports route and agent changes for client_context.
  liveContextChanged: () => ipcRenderer.send("ditto-live:context-changed"),
  onLiveActive: (listener) => {
    const handler = (_event, active) => listener(active);
    ipcRenderer.on("ditto:live-active", handler);
    return () => ipcRenderer.removeListener("ditto:live-active", handler);
  },
  onLiveTokenRequest: (listener) => {
    const responder = (id) => listener(id);
    liveTokenResponder = responder;
    for (const id of liveTokenRequests.splice(0)) responder(id);
    return () => {
      if (liveTokenResponder === responder) liveTokenResponder = null;
    };
  },
  liveTokenReply: (id, reply) =>
    ipcRenderer.invoke("ditto:live-token", id, {
      token: typeof reply?.token === "string" ? reply.token : undefined,
      error: typeof reply?.error === "string" ? reply.error : undefined,
    }),
});

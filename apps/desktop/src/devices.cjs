const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const WebSocket = require("ws");

const RPC_PATH = "/ditto-desktop/v1";
const MAX_FRAME = 65536;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

class DesktopDevices {
  constructor({
    apiBase,
    getKey,
    getHostId = () => null,
    saveHostId = () => {},
    version,
    onStatus = () => {},
    maintenance,
    WebSocketImpl = WebSocket,
    fetchImpl = fetch,
  }) {
    this.apiBase = apiBase;
    this.getKey = getKey;
    this.getHostId = getHostId;
    this.saveHostId = saveHostId;
    this.version = version;
    this.onStatus = onStatus;
    this.maintenance = maintenance;
    this.WebSocket = WebSocketImpl;
    this.fetch = fetchImpl;
    const hostId = getHostId();
    this.hostId = typeof hostId === "string" && UUID.test(hostId) ? hostId : null;
    this.socket = null;
    this.enabled = false;
    this.paired = new Set();
    this.tunnels = new Map();
    this.replays = new Map();
    this.clients = new Set();
    this.state = { online: false, detail: "Device network is off." };
    this.retry = 1000;
  }
  status() {
    return {
      ...this.state,
      enabled: this.enabled,
      hostId: this.hostId,
      pairedCount: this.paired.size,
    };
  }
  report(online, detail) {
    this.state = { online, detail };
    this.onStatus(this.status());
  }
  wsUrl(route) {
    const url = new URL(route, this.apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  start() {
    this.getKey();
    if (this.enabled) return this.status();
    this.enabled = true;
    this.connect();
    return this.status();
  }
  connect() {
    if (!this.enabled) return;
    this.report(false, "Connecting this Mac to Ditto…");
    let socket;
    try {
      socket = new this.WebSocket(this.wsUrl("/api/v5/hosts/ws"), {
        headers: { Authorization: `Bearer ${this.getKey()}` },
        maxPayload: 4 * 1024 * 1024,
        handshakeTimeout: 15000,
      });
    } catch {
      this.stop();
      this.report(false, "Sign in with Ditto to connect this Mac.");
      return;
    }
    this.socket = socket;
    this.lastPong = Date.now();
    const welcomeDeadline = setTimeout(() => socket.terminate(), 20000);
    socket.on("open", () => {
      this.send({
        type: "hello",
        ...(this.hostId ? { hostId: this.hostId } : {}),
        kind: "desktop",
        name: os.hostname().replace(/\.local$/, ""),
        platform: os.platform(),
        version: this.version,
        capabilities: { harnesses: [], attachments: false, headless: false, teleport: true },
      });
    });
    socket.on("message", (bytes) => {
      if (this.socket !== socket) return;
      try {
        const frame = JSON.parse(bytes.toString());
        if (frame.type === "welcome" && UUID.test(frame.hostId)) {
          clearTimeout(welcomeDeadline);
          this.hostId = frame.hostId;
          this.saveHostId(frame.hostId);
          this.setPaired(frame.pairedHostIds);
          this.retry = 1000;
          this.lastPong = Date.now();
          this.report(true, "This Mac is online in your Ditto device network.");
          clearInterval(this.heartbeat);
          const interval = Math.min(60000, Math.max(5000, (frame.heartbeatSeconds || 30) * 1000));
          this.heartbeat = setInterval(() => {
            if (Date.now() - this.lastPong > interval * 3) socket.terminate();
            else this.send({ type: "ping" });
          }, interval);
          this.heartbeat.unref();
        } else if (frame.type === "pong") this.lastPong = Date.now();
        else if (frame.type === "ping") this.send({ type: "pong" });
        else if (frame.type === "hosts.paired") this.setPaired(frame.hostIds);
        else if (frame.type === "env.open") this.openTunnel(frame);
        else if (frame.type === "env.close") this.tunnels.delete(frame.tunnelId);
        else if (frame.type === "env.frame") void this.onTunnelFrame(frame);
        else if (frame.type === "error")
          this.report(
            false,
            "Ditto rejected the device connection. Reconnect after checking sign-in.",
          );
      } catch {
        /* Invalid frames never invoke a command. */
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(welcomeDeadline);
      if (this.socket !== socket) return;
      clearInterval(this.heartbeat);
      this.socket = null;
      this.tunnels.clear();
      this.paired.clear();
      if (this.enabled) {
        this.report(false, "Connection lost. Reconnecting…");
        this.reconnect = setTimeout(() => this.connect(), this.retry);
        this.reconnect.unref();
        this.retry = Math.min(30000, this.retry * 2);
      }
    });
  }
  stop() {
    this.enabled = false;
    clearTimeout(this.reconnect);
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    for (const client of this.clients) client.terminate();
    this.clients.clear();
    this.tunnels.clear();
    this.paired.clear();
    this.report(false, "Device network is off.");
    return this.status();
  }
  send(frame) {
    if (
      this.socket?.readyState === this.WebSocket.OPEN &&
      this.socket.bufferedAmount < 4 * 1024 * 1024
    )
      this.socket.send(JSON.stringify(frame));
  }
  setPaired(ids) {
    this.paired = new Set(
      Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && UUID.test(id)) : [],
    );
    for (const [id, tunnel] of this.tunnels)
      if (tunnel.peer && !this.paired.has(tunnel.peer))
        this.closeTunnel(id, "Device pairing removed.");
  }
  closeTunnel(id, reason) {
    this.tunnels.delete(id);
    this.send({ type: "env.close", tunnelId: id, reason });
  }
  openTunnel(frame) {
    if (!UUID.test(frame.tunnelId)) return;
    if (
      !this.state.online ||
      frame.path !== RPC_PATH ||
      this.tunnels.size >= 8 ||
      this.tunnels.has(frame.tunnelId) ||
      (frame.peerHostId !== "" && !this.paired.has(frame.peerHostId))
    ) {
      this.send({
        type: "env.close",
        tunnelId: frame.tunnelId,
        reason: "Unsupported or unpaired Desktop connection.",
      });
      return;
    }
    this.tunnels.set(frame.tunnelId, { peer: frame.peerHostId, pending: 0 });
  }
  async onTunnelFrame(frame) {
    const tunnel = this.tunnels.get(frame.tunnelId);
    if (!tunnel) return;
    if (
      typeof frame.payload !== "string" ||
      frame.payload.length > MAX_FRAME * 1.4 ||
      tunnel.pending >= 4
    ) {
      this.closeTunnel(frame.tunnelId, "Desktop request limit exceeded.");
      return;
    }
    let request;
    try {
      const bytes = Buffer.from(frame.payload, "base64");
      if (bytes.length > MAX_FRAME) throw new Error("Frame too large");
      request = JSON.parse(bytes.toString());
      if (
        !UUID.test(request.id) ||
        request.version !== 1 ||
        !["desktop.status", "engines.status", "engines.update"].includes(request.method)
      )
        throw new Error("Invalid method");
      if (
        request.method === "engines.update" &&
        (!request.params ||
          Object.keys(request.params).length !== 1 ||
          !["codex", "claude", "cursor", "grok"].includes(request.params.provider))
      )
        throw new Error("Invalid engine");
      if (request.method !== "engines.update" && request.params !== undefined)
        throw new Error("Unexpected params");
    } catch {
      this.closeTunnel(frame.tunnelId, "Invalid Desktop request.");
      return;
    }
    tunnel.pending++;
    // A reconnect or duplicate delivery must not run an installation twice.
    const replayKey = `${tunnel.peer || "owner"}:${request.id}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.method, request.params]))
      .digest("hex");
    for (const [key, entry] of this.replays)
      if (entry.done && Date.now() - entry.at > 600000) this.replays.delete(key);
    let entry = this.replays.get(replayKey);
    if (entry && entry.fingerprint !== fingerprint) {
      this.closeTunnel(frame.tunnelId, "Request ID reused.");
      tunnel.pending--;
      return;
    }
    if (!entry) {
      if (this.replays.size >= 256) {
        this.closeTunnel(frame.tunnelId, "Desktop request limit exceeded.");
        tunnel.pending--;
        return;
      }
      entry = { at: Date.now(), fingerprint, done: false };
      entry.result = Promise.resolve()
        .then(() => {
          // Pairing or the connection can disappear after a frame is queued.
          // Recheck before starting an updater; an already running update is not cancelled.
          if (
            !this.state.online ||
            this.tunnels.get(frame.tunnelId) !== tunnel ||
            (tunnel.peer && !this.paired.has(tunnel.peer))
          )
            throw new Error("Desktop connection closed before the request started.");
          return request.method === "desktop.status"
            ? {
                name: "Ditto Desktop",
                version: this.version,
                online: this.state.online,
                capabilities: ["engine-maintenance"],
              }
            : request.method === "engines.status"
              ? this.maintenance.status()
              : this.maintenance.update(request.params.provider);
        })
        .then(
          (result) => ({ version: 1, id: request.id, result }),
          (error) => ({
            version: 1,
            id: request.id,
            error: String(error.message || error).slice(0, 1000),
          }),
        )
        .finally(() => {
          entry.done = true;
          entry.at = Date.now();
        });
      this.replays.set(replayKey, entry);
    }
    try {
      const response = await entry.result;
      if (this.tunnels.get(frame.tunnelId) === tunnel)
        this.send({
          type: "env.frame",
          tunnelId: frame.tunnelId,
          payload: Buffer.from(JSON.stringify(response)).toString("base64"),
        });
    } finally {
      tunnel.pending--;
    }
  }
  requireOnline() {
    if (!this.state.online || !this.hostId)
      throw new Error("Connect this Mac to the device network first.");
  }
  async api(route, method = "GET", body) {
    const response = await this.fetch(new URL(route, this.apiBase), {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${this.getKey()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`Ditto device request failed (HTTP ${response.status}).`);
    if (response.status === 204) return null;
    return response.json();
  }
  async list() {
    const data = await this.api(`/api/v5/hosts${this.hostId ? `?hostId=${this.hostId}` : ""}`);
    return data.hosts || [];
  }
  async pairCode() {
    this.requireOnline();
    return this.api("/api/v5/hosts/pairings", "POST", { hostId: this.hostId });
  }
  async claim(code) {
    this.requireOnline();
    if (typeof code !== "string" || !/^\d{6}$/.test(code))
      throw new Error("Enter the six-digit code from your other Mac.");
    return this.api("/api/v5/hosts/pairings/claim", "POST", { code, hostId: this.hostId });
  }
  async unpair(peer) {
    this.requireOnline();
    if (!UUID.test(peer) || !this.paired.has(peer)) throw new Error("Choose a paired device.");
    const hostId = this.hostId;
    const socket = this.socket;
    const result = await this.api(`/api/v5/hosts/${hostId}/pairings/${peer}`, "DELETE");
    // The acknowledgement can precede the pairing event, or outlive this connection.
    if (this.hostId === hostId && this.socket === socket)
      this.setPaired([...this.paired].filter((id) => id !== peer));
    return result;
  }
  async request(peer, method, params) {
    this.requireOnline();
    if (!UUID.test(peer) || !this.paired.has(peer))
      throw new Error("Pair this device before managing its engines.");
    if (!["desktop.status", "engines.status", "engines.update"].includes(method))
      throw new Error("Unsupported Desktop request.");
    if (
      method === "engines.update" &&
      (!params ||
        Object.keys(params).length !== 1 ||
        !["codex", "claude", "cursor", "grok"].includes(params.provider))
    )
      throw new Error("Unsupported coding engine.");
    const id = randomUUID();
    const route = `/api/v5/hosts/${peer}/env?fromHostId=${this.hostId}&path=${encodeURIComponent(RPC_PATH)}`;
    return new Promise((resolve, reject) => {
      const client = new this.WebSocket(this.wsUrl(route), {
        headers: { Authorization: `Bearer ${this.getKey()}` },
        maxPayload: MAX_FRAME,
        handshakeTimeout: 15000,
      });
      this.clients.add(client);
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.clients.delete(client);
        client.close();
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () =>
          finish(
            new Error("The other Mac did not respond. Check its network and Desktop version."),
          ),
        method === "engines.update" ? 330000 : 30000,
      );
      client.on("open", () => {
        if (!this.state.online || !this.paired.has(peer)) {
          finish(
            new Error("Desktop connection or paired device changed before the request started."),
          );
          return;
        }
        client.send(JSON.stringify({ version: 1, id, method, ...(params ? { params } : {}) }));
      });
      client.on("message", (bytes) => {
        try {
          const frame = JSON.parse(bytes.toString());
          if (frame.id !== id || frame.version !== 1) return;
          finish(frame.error ? new Error(frame.error) : null, frame.result);
        } catch {
          finish(new Error("The other Mac returned an invalid Desktop response."));
        }
      });
      client.on("error", () =>
        finish(new Error("Could not reach the paired Mac. Check that Ditto Desktop is online.")),
      );
      client.on("close", () =>
        finish(new Error("The paired Mac disconnected before the request finished.")),
      );
    });
  }
}

module.exports = { DesktopDevices, RPC_PATH };

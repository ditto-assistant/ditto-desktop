const WebSocket = require("ws");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

class ComputerRelay {
  constructor({ service, apiBase, onChange = () => {}, WebSocketImpl = WebSocket }) {
    this.service = service;
    this.apiBase = apiBase;
    this.onChange = onChange;
    this.WebSocket = WebSocketImpl;
    this.sessions = new Map();
    this.opening = new Map();
    // Cancelled startups consume capacity until their helper creation settles.
    this.creating = new Set();
    this.pending = new Set();
    this.completed = new Set();
    this.leaseID = "";
    this.detail = "Cloud chats are disconnected.";
  }
  status() {
    return { connected: Boolean(this.leaseID), leaseID: this.leaseID, detail: this.detail };
  }
  stop(detail = "Cloud chats are disconnected.") {
    this.detail = detail;
    this.leaseID = "";
    clearInterval(this.heartbeat);
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.opening.clear();
    this.pending.clear();
    this.completed.clear();
    this.onChange(this.status());
  }
  async link(token) {
    if (!this.service.enabled) {
      this.stop();
      return this.status();
    }
    if (
      typeof token !== "string" ||
      token.length < 20 ||
      token.length > 10000 ||
      /[\r\n]/.test(token)
    )
      throw new Error("Sign in with Ditto to connect computer tools.");
    if (this.leaseID && this.socket?.readyState === this.WebSocket.OPEN) return this.status();
    this.stop();
    const url = new URL("/api/v5/desktop/computer/ws", this.apiBase);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new this.WebSocket(url, {
      headers: { Authorization: `Bearer ${token}` },
      maxPayload: 128000,
      handshakeTimeout: 15000,
    });
    this.socket = socket;
    let lastPong = Date.now();
    socket.on("pong", () => {
      lastPong = Date.now();
    });
    this.heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 60000) socket.terminate();
      else if (socket.readyState === this.WebSocket.OPEN) socket.ping();
    }, 20000);
    this.heartbeat.unref();
    return new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        socket.terminate();
      }, 15000);
      const disconnected = () => {
        clearTimeout(timer);
        if (this.socket === socket)
          this.stop("Cloud computer tools are disconnected. Local Ditto Code remains available.");
        if (!ready)
          reject(
            new Error(
              "Cloud computer tools need the updated Ditto backend. Local Ditto Code remains available.",
            ),
          );
      };
      socket.on("error", disconnected);
      socket.on("close", disconnected);
      socket.on("message", (data) => {
        if (this.socket !== socket || !this.service.enabled) return;
        let frame;
        try {
          frame = JSON.parse(data.toString());
          if (!frame || typeof frame !== "object" || Array.isArray(frame))
            throw new Error("Invalid cloud computer frame.");
        } catch {
          socket.terminate();
          return;
        }
        if (!ready) {
          if (frame.type !== "ready" || !UUID.test(frame.leaseID)) {
            socket.terminate();
            return;
          }
          clearTimeout(timer);
          ready = true;
          this.leaseID = frame.leaseID;
          this.detail = "Regular Ditto agents are connected to this Mac.";
          this.onChange(this.status());
          resolve(this.status());
          return;
        }
        void this.handle(socket, frame);
      });
    });
  }
  async handle(socket, frame) {
    if (
      !UUID.test(frame.id) ||
      !UUID.test(frame.turnID) ||
      !Number.isFinite(frame.deadline) ||
      frame.deadline * 1000 < Date.now() ||
      this.pending.has(frame.id) ||
      this.completed.has(frame.id)
    )
      return;
    if (this.pending.size >= 8) {
      socket.terminate();
      return;
    }
    this.pending.add(frame.id);
    const owner = this.leaseID;
    let result;
    let error;
    try {
      if (frame.method === "open") {
        if (
          this.sessions.has(frame.turnID) ||
          this.opening.has(frame.turnID) ||
          this.sessions.size + this.creating.size >= 4
        )
          throw new Error();
        // Reserve before yielding; Stop or a new lease may replace this reservation.
        const reservation = {};
        this.opening.set(frame.turnID, reservation);
        this.creating.add(reservation);
        try {
          const session = await this.service.createSession();
          if (
            this.socket !== socket ||
            this.leaseID !== owner ||
            !this.service.enabled ||
            this.opening.get(frame.turnID) !== reservation
          ) {
            session.close();
            throw new Error();
          }
          this.sessions.set(frame.turnID, session);
          result = { tools: session.tools };
        } finally {
          this.creating.delete(reservation);
          if (this.opening.get(frame.turnID) === reservation) this.opening.delete(frame.turnID);
        }
      } else if (frame.method === "call") {
        const session = this.sessions.get(frame.turnID);
        if (!session) throw new Error();
        result = await session.call(frame.params?.name, frame.params?.arguments);
      } else if (frame.method === "close") {
        this.opening.delete(frame.turnID);
        this.sessions.get(frame.turnID)?.close();
        this.sessions.delete(frame.turnID);
        result = {};
      } else throw new Error();
    } catch {
      error = "Computer Use stopped or disconnected.";
    } finally {
      this.pending.delete(frame.id);
      this.completed.add(frame.id);
      if (this.completed.size > 4096) {
        this.stop();
      }
    }
    if (this.socket !== socket || !this.service.enabled || this.leaseID !== owner) return;
    let response = JSON.stringify({ id: frame.id, result, error });
    if (response.length > 4 * 1024 * 1024)
      response = JSON.stringify({
        id: frame.id,
        error: "Computer Use result is too large. Request a smaller view.",
      });
    if (socket.readyState === this.WebSocket.OPEN) socket.send(response);
  }
}

module.exports = { ComputerRelay };

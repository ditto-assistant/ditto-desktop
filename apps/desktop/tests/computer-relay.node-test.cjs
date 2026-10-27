const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { WebSocketServer } = require("ws");
const { ComputerRelay } = require("../src/computer-relay.cjs");
const { spawn } = require("node:child_process");
const path = require("node:path");

for (const ready of [false, true])
  test(`non-object cloud frames disconnect safely (ready=${ready})`, async (t) => {
    const worker = spawn(
      process.execPath,
      [
        "-e",
        `
const assert=require("node:assert/strict");
const {once}=require("node:events");
const {randomUUID}=require("node:crypto");
const {ComputerRelay}=require(process.argv[1]);
const {WebSocketServer}=require(process.argv[2]);
(async()=>{
  for(const frame of [null,true,42,[],"diagnostic"]){
    const server=new WebSocketServer({host:"127.0.0.1",port:0});
    await once(server,"listening");
    let created=0,closed=0,onDisconnected;
    const relay=new ComputerRelay({apiBase:"http://127.0.0.1:"+server.address().port,onChange:status=>{if(!status.connected)onDisconnected?.();},service:{
      enabled:true,createSession:async()=>{created++;return {tools:[],close:()=>closed++};}
    }});
    try{
      const connected=relay.link("synthetic-cloud-fixture-token").then(value=>({value}),error=>({error}));
      const [peer]=await once(server,"connection");
      if(${ready}){
        peer.send(JSON.stringify({type:"ready",leaseID:randomUUID()}));
        assert.ok((await connected).value.connected);
        const opened=once(peer,"message");
        peer.send(JSON.stringify({id:randomUUID(),turnID:randomUUID(),method:"open",deadline:Math.floor(Date.now()/1000)+60}));
        assert.ok(JSON.parse((await opened)[0]).result);
      }
      const disconnected=once(peer,"close");
      const stopped=Promise.withResolvers();onDisconnected=stopped.resolve;
      peer.send(JSON.stringify(frame));
      await Promise.all([disconnected,stopped.promise]);
      if(!${ready})assert.ok((await connected).error);
      assert.equal(relay.status().connected,false);
      assert.equal(relay.sessions.size,0);
      assert.equal(created,${ready ? 1 : 0});assert.equal(closed,created);
    }finally{
      relay.stop();for(const peer of server.clients)peer.terminate();
      await new Promise(resolve=>server.close(resolve));
    }
  }
  console.log("NON_OBJECT_FRAMES_DISCONNECTED");
})().catch(error=>{console.error(error);process.exitCode=1});
`,
        path.resolve(__dirname, "../src/computer-relay.cjs"),
        require.resolve("ws"),
      ],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      errors = "";
    worker.stdout.on("data", (data) => {
      output += data;
    });
    worker.stderr.on("data", (data) => {
      errors += data;
    });
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null) {
        const closed = once(worker, "close");
        worker.kill("SIGKILL");
        await closed;
      }
    });
    const [code] = await once(worker, "close");
    assert.equal(code, 0, errors);
    assert.match(output, /NON_OBJECT_FRAMES_DISCONNECTED/);
  });

test("cloud relay binds tools to turns and closes capabilities on disconnect", async (t) => {
  const server = http.createServer();
  const ws = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const calls = [];
  let closed = 0;
  const relay = new ComputerRelay({
    apiBase: `http://127.0.0.1:${server.address().port}`,
    service: {
      enabled: true,
      createSession: async () => ({
        tools: [{ name: "computer_click" }],
        call: async (name, args) => {
          calls.push({ name, args });
          return { content: [{ type: "text", text: "fixture clicked" }] };
        },
        close: () => {
          closed++;
        },
      }),
    },
  });
  t.after(async () => {
    relay.stop();
    ws.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const connecting = relay.link("fixture-bearer-credential");
  const [host, request] = await once(ws, "connection");
  assert.equal(request.headers.authorization, "Bearer fixture-bearer-credential");
  assert.equal(request.url, "/api/v5/desktop/computer/ws");
  host.send(JSON.stringify({ type: "ready", leaseID: randomUUID() }));
  await connecting;
  const send = async (method, turnID, params) => {
    const response = once(host, "message");
    host.send(
      JSON.stringify({
        id: randomUUID(),
        method,
        turnID,
        params,
        deadline: Math.floor(Date.now() / 1000) + 60,
      }),
    );
    return JSON.parse((await response)[0]);
  };
  const turn = randomUUID();
  const tools = await send("open", turn);
  assert.equal(tools.result.tools[0].name, "computer_click");
  assert.ok((await send("call", randomUUID(), { name: "computer_click" })).error);
  assert.equal(calls.length, 0);
  await send("call", turn, { name: "computer_click", arguments: { window_id: 42 } });
  assert.deepEqual(calls, [{ name: "computer_click", args: { window_id: 42 } }]);
  await send("close", turn);
  assert.equal(closed, 1);
  await send("open", randomUUID());
  const disconnected = once(host, "close");
  relay.stop();
  await disconnected;
  assert.equal(closed, 2);
  assert.equal(relay.status().connected, false);
  assert.equal(relay.sessions.size, 0);
});

function pendingOpens(t) {
  const creations = [];
  const responses = [];
  const socket = {
    readyState: 1,
    send: (data) => responses.push(JSON.parse(data)),
    terminate() {},
  };
  const relay = new ComputerRelay({
    apiBase: "https://example.invalid",
    service: {
      enabled: true,
      createSession: () => {
        const ready = Promise.withResolvers();
        const session = {
          tools: [],
          call() {},
          closed: false,
          close() {
            this.closed = true;
          },
        };
        creations.push({ ready, session });
        return ready.promise;
      },
    },
  });
  relay.socket = socket;
  relay.leaseID = randomUUID();
  t.after(() => relay.stop());
  return {
    relay,
    socket,
    creations,
    responses,
    open: (turnID = randomUUID()) =>
      relay.handle(socket, {
        id: randomUUID(),
        method: "open",
        turnID,
        deadline: Math.floor(Date.now() / 1000) + 60,
      }),
    release: () => creations.forEach(({ ready, session }) => ready.resolve(session)),
  };
}

test("concurrent opens for one turn cannot overwrite an owned computer session", async (t) => {
  const f = pendingOpens(t);
  const turn = randomUUID();
  const first = f.open(turn);
  const duplicate = f.open(turn);
  f.release();
  await Promise.all([first, duplicate]);
  assert.equal(f.creations.length, 1);
  assert.equal(f.relay.sessions.get(turn), f.creations[0].session);
  f.relay.stop();
  assert.ok(f.creations.every(({ session }) => session.closed));
});

test("pending opens count toward the four-session relay limit", async (t) => {
  const f = pendingOpens(t);
  const opens = Array.from({ length: 5 }, () => f.open());
  f.release();
  await Promise.all(opens);
  assert.equal(f.creations.length, 4);
  assert.equal(f.relay.sessions.size, 4);
});

test("a stopped opening cannot release a replacement lease's turn reservation", async (t) => {
  const f = pendingOpens(t);
  const turn = randomUUID();
  const stale = f.open(turn);
  f.relay.stop();
  f.relay.socket = f.socket;
  f.relay.leaseID = randomUUID();
  const current = f.open(turn);
  f.creations[0].ready.resolve(f.creations[0].session);
  await stale;
  assert.equal(f.creations[0].session.closed, true);
  const duplicate = f.open(turn);
  f.release();
  await Promise.all([current, duplicate]);
  assert.equal(f.creations.length, 2);
  assert.equal(f.relay.sessions.get(turn), f.creations[1].session);
});

test("a failed session opening releases its turn for another attempt", async (t) => {
  const f = pendingOpens(t);
  const turn = randomUUID();
  const failed = f.open(turn);
  f.creations[0].ready.reject(new Error("fixture helper disconnected"));
  await failed;
  const retry = f.open(turn);
  f.creations[1].ready.resolve(f.creations[1].session);
  await retry;
  assert.equal(f.relay.sessions.get(turn), f.creations[1].session);
});

test("closing a pending turn closes its late session without replacing a reopened turn", async (t) => {
  const f = pendingOpens(t);
  const turn = randomUUID();
  const stale = f.open(turn);
  await f.relay.handle(f.socket, {
    id: randomUUID(),
    method: "close",
    turnID: turn,
    deadline: Math.floor(Date.now() / 1000) + 60,
  });
  const current = f.open(turn);
  f.release();
  await Promise.all([stale, current]);
  assert.equal(f.creations.length, 2);
  assert.equal(f.creations[0].session.closed, true);
  assert.equal(f.relay.sessions.get(turn), f.creations[1].session);
  assert.equal(f.responses.filter((response) => response.error).length, 1);
});

test("cancelled startups retain capacity until their helper creation settles", async (t) => {
  const f = pendingOpens(t);
  const turns = Array.from({ length: 4 }, () => randomUUID());
  const opens = turns.map((turn) => f.open(turn));
  await f.relay.handle(f.socket, {
    id: randomUUID(),
    method: "close",
    turnID: turns[0],
    deadline: Math.floor(Date.now() / 1000) + 60,
  });
  const overflow = f.open();
  assert.equal(f.creations.length, 4);
  await overflow;
  f.creations[0].ready.resolve(f.creations[0].session);
  await opens[0];
  assert.equal(f.creations[0].session.closed, true);
  const replacement = f.open();
  assert.equal(f.creations.length, 5);
  f.release();
  await Promise.all([...opens, replacement]);
  assert.equal(f.relay.sessions.size, 4);
});

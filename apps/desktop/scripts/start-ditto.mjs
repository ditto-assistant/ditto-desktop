import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

ensureElectronRuntime();
const require = NodeModule.createRequire(import.meta.url);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = NodeChildProcess.spawn(require("electron"), ["."], {
  cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
  env,
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});

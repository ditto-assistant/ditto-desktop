const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { codeComposerOverlay } = require("../scripts/desktop-code-bridge.cjs");
const sourcePath = path.join(__dirname, "../web/ditto-app/src/components/code/codeComposer.ts");

test(
  "the shared web composer dispatches local tasks and isolates local and cloud drafts",
  { skip: !fs.existsSync(sourcePath) },
  async () => {
    const ts = require("../web/ditto-app/node_modules/typescript");
    const source = fs.readFileSync(
      path.join(__dirname, "../web/ditto-app/src/components/code/codeComposer.ts"),
      "utf8",
    );
    const patched = codeComposerOverlay(source).replaceAll(
      "import.meta.env.VITE_DITTO_DESKTOP",
      "true",
    );
    const code = ts.transpileModule(patched, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const handlers = {};
    const context = {
      exports: {},
      require: (name) => {
        assert.equal(name, "solid-js");
        return {
          createSignal: (value) => [() => value, (next) => (value = next)],
          createMemo: (fn) => fn,
        };
      },
      window: { addEventListener: (type, fn) => (handlers[type] = fn) },
    };
    vm.runInNewContext(code, context);
    const api = context.exports;
    api.setCodeTaskDraft("cloud draft");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: true } });
    assert.equal(api.codeTaskDraft(), "");
    api.setCodeTaskDraft("local draft");
    context.dittoDesktopStartCode = async () => ({ status: "started", jobId: "local-id" });
    api.registerCodeTaskStarter(async () => ({ status: "started", jobId: "cloud-id" }));
    assert.equal((await api.startCodeTaskFromComposer({ prompt: "task" })).jobId, "local-id");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: false } });
    assert.equal(api.codeTaskDraft(), "cloud draft");
    context.dittoDesktopStartCode = async () => null;
    assert.equal((await api.startCodeTaskFromComposer({ prompt: "task" })).jobId, "cloud-id");
    handlers["ditto-desktop-execution-mode"]({ detail: { local: true } });
    assert.equal(api.codeTaskDraft(), "local draft");
  },
);

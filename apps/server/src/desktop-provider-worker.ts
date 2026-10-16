// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { isToolLifecycleItemType, ProviderApprovalDecision } from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig, deriveServerPaths, ensureServerDirectories } from "./config.ts";
import {
  DesktopProviderError,
  DesktopProviderStart,
  makeDesktopProviderAdapter,
  runDesktopProviderTurn,
} from "./desktopProviderRuntime.ts";

const workerProcess = NodeProcess.getBuiltinModule("process");

const Control = Schema.Struct({
  type: Schema.Literal("approval"),
  requestId: Schema.String,
  decision: ProviderApprovalDecision,
});
const decodeControl = Schema.decodeUnknownExit(Control);
const decodeStart = Schema.decodeUnknownEffect(DesktopProviderStart);
const isCancel = Schema.is(Schema.Struct({ type: Schema.Literal("cancel") }));
const send = (message: object) => {
  if (workerProcess.connected) workerProcess.send?.(message);
};

// No listener, web renderer, T3 database, relay or telemetry is started here.
const configLayer = (input: DesktopProviderStart) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const paths = yield* deriveServerPaths(input.stateDir, undefined, {
        baseDirIsExplicit: true,
      });
      yield* ensureServerDirectories(paths);
      return ServerConfig.of({
        ...paths,
        cwd: input.session.cwd ?? workerProcess.cwd(),
        baseDir: input.stateDir,
        mode: "desktop",
        port: 0,
        host: undefined,
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        logLevel: "Error",
        traceMinLevel: "Error",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1048576,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otlpServiceName: "ditto-provider-runtime",
      });
    }),
  );

const main = Effect.fn("desktopProviderWorker")(function* (input: DesktopProviderStart) {
  const adapter = yield* makeDesktopProviderAdapter(input.provider, input.binaryPath);
  const approvals = new Map<
    string,
    Deferred.Deferred<ProviderApprovalDecision, DesktopProviderError>
  >();
  const context = yield* Effect.context<never>();
  const control = (message: unknown) => {
    const decoded = decodeControl(message);
    if (decoded._tag === "Failure") return;
    const request = approvals.get(decoded.value.requestId);
    if (request) Effect.runSyncWith(context)(Deferred.succeed(request, decoded.value.decision));
  };
  workerProcess.on("message", control);
  yield* Effect.addFinalizer(() => Effect.sync(() => workerProcess.off("message", control)));
  const result = yield* runDesktopProviderTurn(adapter, input, {
    event: (event, live) => {
      const tool =
        live &&
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        isToolLifecycleItemType(event.payload.itemType)
          ? {
              name: event.payload.title || event.payload.itemType,
              status: event.payload.status,
              detail: event.payload.detail,
            }
          : undefined;
      send({ type: "event", event, tool, live });
    },
    resume: (resumeCursor) => send({ type: "session", resumeCursor }),
    approve: (event) =>
      Effect.gen(function* () {
        const requestId = event.requestId;
        if (!requestId)
          return yield* new DesktopProviderError({
            message: "Permission request has no identifier.",
          });
        const response = yield* Deferred.make<ProviderApprovalDecision, DesktopProviderError>();
        approvals.set(requestId, response);
        send({ type: "approval", event });
        return yield* Deferred.await(response).pipe(
          Effect.ensuring(Effect.sync(() => approvals.delete(requestId))),
        );
      }),
  });
  return result;
});

const lifetime = new AbortController();
workerProcess.on("message", (message: unknown) => {
  if (isCancel(message)) lifetime.abort();
});
workerProcess.once("message", (message: unknown) => {
  const program = Effect.gen(function* () {
    const input = yield* decodeStart(message);
    return yield* main(input).pipe(
      Effect.provide(configLayer(input).pipe(Layer.provide(NodeServices.layer))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.match({
      onSuccess: (result) => send({ type: "result", result }),
      onFailure: (error) => {
        send({ type: "error", message: error.message });
        workerProcess.exitCode = 1;
      },
    }),
  );
  void Effect.runPromise(program, { signal: lifetime.signal })
    .catch(() => {
      if (lifetime.signal.aborted) send({ type: "result", result: { text: "", cancelled: true } });
      else {
        send({ type: "error", message: "Coding runtime stopped unexpectedly." });
        workerProcess.exitCode = 1;
      }
    })
    .finally(() => {
      if (workerProcess.connected) workerProcess.disconnect();
    });
});
workerProcess.once("disconnect", () => lifetime.abort());

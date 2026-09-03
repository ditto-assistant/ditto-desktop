import { DesktopGoogleMessagesSignInOutcomeSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  cancelGoogleMessagesSignIn,
  signInToGoogleMessages,
} from "../../googlemessages/GoogleMessagesSignIn.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// DITTO: the renderer asks for a Google sign-in and receives only the Google
// auth cookies (or a cancellation); it then posts them to the Ditto backend,
// which starts pairing through the hosted bridge.
export const googleMessagesSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_MESSAGES_SIGN_IN_CHANNEL,
  payload: Schema.Undefined,
  result: DesktopGoogleMessagesSignInOutcomeSchema,
  handler: Effect.fn("desktop.ipc.googleMessages.signIn")(function* () {
    return yield* Effect.promise(() => signInToGoogleMessages());
  }),
});

export const googleMessagesCancelSignIn = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GOOGLE_MESSAGES_CANCEL_SIGN_IN_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.googleMessages.cancelSignIn")(function* () {
    yield* Effect.sync(() => cancelGoogleMessagesSignIn());
  }),
});

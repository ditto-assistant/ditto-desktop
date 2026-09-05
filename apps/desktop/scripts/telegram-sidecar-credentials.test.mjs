import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { resolveTelegramBuildCredentials } from "./telegram-sidecar-credentials.mjs";

NodeTest.test("allows an intentionally unconfigured local build", () => {
  NodeAssert.deepEqual(resolveTelegramBuildCredentials({}), {
    configured: false,
    apiID: "",
    apiHash: "",
  });
});

NodeTest.test("normalizes a complete Ditto application credential pair", () => {
  NodeAssert.deepEqual(
    resolveTelegramBuildCredentials({
      DITTO_TELEGRAM_API_ID: " 123456 ",
      DITTO_TELEGRAM_API_HASH: " ABCDEF0123456789ABCDEF0123456789 ",
    }),
    {
      configured: true,
      apiID: "123456",
      apiHash: "abcdef0123456789abcdef0123456789",
    },
  );
});

NodeTest.test("rejects partial credentials", () => {
  NodeAssert.throws(
    () => resolveTelegramBuildCredentials({ DITTO_TELEGRAM_API_ID: "123456" }),
    /must be provided together/,
  );
  NodeAssert.throws(
    () =>
      resolveTelegramBuildCredentials({
        DITTO_TELEGRAM_API_HASH: "abcdef0123456789abcdef0123456789",
      }),
    /must be provided together/,
  );
});

NodeTest.test("rejects values that could alter Go linker arguments", () => {
  NodeAssert.throws(
    () =>
      resolveTelegramBuildCredentials({
        DITTO_TELEGRAM_API_ID: "123 -X main.other=value",
        DITTO_TELEGRAM_API_HASH: "abcdef0123456789abcdef0123456789",
      }),
    /positive decimal integer/,
  );
  NodeAssert.throws(
    () =>
      resolveTelegramBuildCredentials({
        DITTO_TELEGRAM_API_ID: "123456",
        DITTO_TELEGRAM_API_HASH: "not-a-telegram-hash",
      }),
    /32-character hexadecimal hash/,
  );
});

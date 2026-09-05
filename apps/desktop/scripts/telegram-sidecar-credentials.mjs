const TELEGRAM_API_HASH_PATTERN = /^[0-9a-f]{32}$/i;
const TELEGRAM_API_ID_PATTERN = /^[0-9]+$/;
const MAX_TELEGRAM_API_ID = 2_147_483_647;

export function resolveTelegramBuildCredentials(environment) {
  const apiID = environment.DITTO_TELEGRAM_API_ID?.trim() ?? "";
  const apiHash = environment.DITTO_TELEGRAM_API_HASH?.trim() ?? "";

  if (apiID === "" && apiHash === "") {
    return { configured: false, apiID: "", apiHash: "" };
  }
  if (apiID === "" || apiHash === "") {
    throw new Error("DITTO_TELEGRAM_API_ID and DITTO_TELEGRAM_API_HASH must be provided together.");
  }
  if (!TELEGRAM_API_ID_PATTERN.test(apiID)) {
    throw new Error("DITTO_TELEGRAM_API_ID must be a positive decimal integer.");
  }
  const numericAPIID = Number(apiID);
  if (
    !Number.isSafeInteger(numericAPIID) ||
    numericAPIID <= 0 ||
    numericAPIID > MAX_TELEGRAM_API_ID
  ) {
    throw new Error("DITTO_TELEGRAM_API_ID must fit Telegram's signed 32-bit API ID range.");
  }
  if (!TELEGRAM_API_HASH_PATTERN.test(apiHash)) {
    throw new Error("DITTO_TELEGRAM_API_HASH must be a 32-character hexadecimal hash.");
  }

  return { configured: true, apiID, apiHash: apiHash.toLowerCase() };
}

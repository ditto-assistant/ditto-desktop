export function normalizeInboxSearchValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);
      if (typeof decoded === "string") return decoded;
    } catch {
      // Preserve malformed legacy values so the route remains inspectable.
    }
  }
  return value;
}

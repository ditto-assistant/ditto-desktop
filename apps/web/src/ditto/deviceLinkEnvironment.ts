/**
 * Which T3 server (environment) holds the Ditto link for this computer.
 *
 * The device-link row lives in Settings, where there is no thread to point at
 * an environment, so it follows the environment registry: the primary (local)
 * server when the app knows one, otherwise the first environment the registry
 * lists (a relay-only session). Reading the registry atoms, rather than the
 * bootstrap-time primary descriptor, keeps the row live as connections come
 * and go.
 */
export function pickDeviceLinkEnvironmentId<Id extends string>(
  primaryEnvironmentId: Id | null,
  environments: ReadonlyArray<{ readonly environmentId: Id }>,
): Id | null {
  if (primaryEnvironmentId !== null) return primaryEnvironmentId;
  return environments[0]?.environmentId ?? null;
}

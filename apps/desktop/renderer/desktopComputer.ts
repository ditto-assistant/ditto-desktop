import type { User } from "firebase/auth";

interface ComputerBridge {
  computerStatus(): Promise<{ enabled: boolean }>;
  computerLease(): string;
  computerCloudLink(token: string | null): Promise<unknown>;
  onComputerCloud?(listener: (status: { connected: boolean }) => void): () => void;
  onComputerEnabled(listener: (enabled: boolean) => void): () => void;
}

function bridge(): ComputerBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { ditto?: ComputerBridge }).ditto;
}

export function desktopComputerMetadata(): { desktopComputerLease?: string } {
  const lease = bridge()?.computerLease?.();
  return lease ? { desktopComputerLease: lease } : {};
}

// Only the signed-in Desktop renderer supplies its current Firebase token.
// Native code keeps it in memory for the connection; it never enters prompts,
// queue metadata, model tools or persistent MCP configuration.
export function connectDesktopComputer(user: User | null): () => void {
  const desktop = bridge();
  if (!desktop?.computerCloudLink) return () => {};
  let disposed = false;
  let generation = 0;
  let desired = false;
  let linking = false;
  let refresh: ReturnType<typeof setTimeout> | undefined;
  const update = async (enabled: boolean) => {
    const owner = ++generation;
    desired = enabled;
    clearTimeout(refresh);
    if (!enabled || !user) {
      await desktop.computerCloudLink(null);
      return;
    }
    linking = true;
    try {
      const token = await user.getIdToken();
      if (disposed || owner !== generation) return;
      await desktop.computerCloudLink(token);
      if (!disposed && owner === generation) {
        refresh = setTimeout(() => void update(true), 25 * 60 * 1000);
      }
    } catch {
      if (!disposed && owner === generation && desired)
        refresh = setTimeout(() => void update(true), 30000);
      // The native setup window shows the disconnected state. Local Code
      // remains available even before the relay backend is deployed.
    } finally {
      if (owner === generation) linking = false;
    }
  };
  const stopCloud = desktop.onComputerCloud?.((status) => {
    if (!status.connected && desired && user && !disposed && !linking) {
      clearTimeout(refresh);
      refresh = setTimeout(() => void update(true), 1000);
    }
  });
  const unsubscribe = desktop.onComputerEnabled((enabled) => void update(enabled));
  const initial = generation;
  void desktop
    .computerStatus()
    .then((status) => {
      if (!disposed && initial === generation) void update(status.enabled);
    })
    .catch(() => {});
  return () => {
    disposed = true;
    ++generation;
    clearTimeout(refresh);
    unsubscribe();
    stopCloud?.();
    void desktop.computerCloudLink(null);
  };
}

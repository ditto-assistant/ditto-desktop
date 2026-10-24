import type { User } from "firebase/auth";

interface LiveBridge {
  onLiveTokenRequest(listener: (id: string) => void): () => void;
  liveTokenReply(id: string, reply: { token?: string; error?: string }): void;
  liveStop?(): Promise<unknown>;
}

function bridge(): LiveBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const desktop = (window as Window & { ditto?: Partial<LiveBridge> }).ditto;
  return desktop?.onLiveTokenRequest && desktop.liveTokenReply
    ? (desktop as LiveBridge)
    : undefined;
}

// Main asks for a token each time Live connects; it keeps it in memory only.
export function answerDesktopLiveTokens(user: User | null): () => void {
  const desktop = bridge();
  if (!desktop) return () => {};
  // A running session would keep acting on this computer for whoever signed out.
  if (!user) void desktop.liveStop?.();
  return desktop.onLiveTokenRequest((id) => {
    if (!user) {
      desktop.liveTokenReply(id, { error: "Sign in to Ditto Desktop before starting Live." });
      return;
    }
    user.getIdToken().then(
      (token) => desktop.liveTokenReply(id, { token }),
      () => desktop.liveTokenReply(id, { error: "Ditto could not refresh your sign-in." }),
    );
  });
}

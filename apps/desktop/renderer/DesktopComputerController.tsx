import { createEffect, onCleanup } from "solid-js";
import { useAuth } from "@/hooks/useAuth";
import { connectDesktopComputer } from "@/desktop/desktopComputer";
import { answerDesktopLiveTokens } from "@/desktop/desktopLive";

export default function DesktopComputerController() {
  const auth = useAuth();
  createEffect(() => {
    const disconnect = connectDesktopComputer(auth.user());
    onCleanup(disconnect);
  });
  createEffect(() => {
    const stop = answerDesktopLiveTokens(auth.user());
    onCleanup(stop);
  });
  return null;
}

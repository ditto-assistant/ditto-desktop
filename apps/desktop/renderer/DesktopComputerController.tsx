import { createEffect, onCleanup } from "solid-js";
import { useAuth } from "@/hooks/useAuth";
import { connectDesktopComputer } from "@/desktop/desktopComputer";
import { answerDesktopLiveTokens } from "@/desktop/desktopLive";
import { connectDesktopLiveActions } from "@/desktop/desktopLiveActions";

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
  onCleanup(connectDesktopLiveActions());
  return null;
}

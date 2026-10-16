import { createEffect, onCleanup } from "solid-js";
import { useAuth } from "@/hooks/useAuth";
import { connectDesktopComputer } from "@/desktop/desktopComputer";

export default function DesktopComputerController() {
  const auth = useAuth();
  createEffect(() => {
    const disconnect = connectDesktopComputer(auth.user());
    onCleanup(disconnect);
  });
  return null;
}

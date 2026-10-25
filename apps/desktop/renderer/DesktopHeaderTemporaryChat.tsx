import { Show } from "solid-js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { V2Icon } from "@/components/v2/V2Brand";
import { mainSurface } from "@/hooks/useHomeScreen";
import { useSurfaceCoordinator } from "@/hooks/useSurfaceCoordinator";
import { track } from "@/lib/analytics";

// ditto-app#3432's header Temporary chat toggle, which frees the composer slot
// beside Send for the Live launcher. Pressed while Temporary Chats is open;
// pressing it again returns to Chats.
export default function DesktopHeaderTemporaryChat() {
  const surfaces = useSurfaceCoordinator();
  const active = () => mainSurface() === "temporary";
  return (
    <Show when={["chat", "new-chat", "temporary"].includes(mainSurface())}>
      <Tooltip placement="bottom">
        <TooltipTrigger
          type="button"
          class="v2-studio-icon-button v2-header-temporary-toggle"
          data-testid="header-temporary-chat"
          aria-label="Temporary chat"
          aria-pressed={active()}
          data-active={active() ? "true" : undefined}
          onClick={() => {
            if (active()) {
              track("temporary_chat", { action: "close", entry: "header" });
              surfaces.openNewChat();
              return;
            }
            track("temporary_chat", { action: "view", entry: "header" });
            surfaces.openTemporaryChats({ focus: true });
          }}
        >
          <V2Icon name="temporary-chat" />
        </TooltipTrigger>
        <TooltipContent>Temporary chat. Not saved to memory.</TooltipContent>
      </Tooltip>
    </Show>
  );
}

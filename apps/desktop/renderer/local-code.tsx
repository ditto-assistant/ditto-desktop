import { createSignal, getOwner, onCleanup, runWithOwner } from "solid-js";
import { render } from "solid-js/web";
import MarkdownRenderer from "@/components/MarkdownRenderer";

type ResponseRenderer = (target: HTMLElement, source: string | null) => void;
type DesktopWindow = Window & { dittoDesktopRenderCodeResponse?: ResponseRenderer };

// Register inside the web Code surface so viewer and translation hooks keep
// their existing providers, even though the desktop shell owns the target nodes.
export function registerDesktopCodeRenderer() {
  const owner = getOwner();
  const host = window as DesktopWindow;
  const responses = new Map<
    HTMLElement,
    { update: (source: string) => void; dispose: () => void }
  >();
  const renderResponse: ResponseRenderer = (target, source) => {
    const current = responses.get(target);
    if (source === null) {
      current?.dispose();
      responses.delete(target);
      return;
    }
    if (current) {
      current.update(source);
      return;
    }
    const [text, setText] = createSignal(source);
    const dispose = runWithOwner(owner, () =>
      render(() => <MarkdownRenderer>{text()}</MarkdownRenderer>, target),
    );
    if (!dispose) throw new Error("The local Code renderer could not mount.");
    responses.set(target, { update: setText, dispose });
  };
  host.dittoDesktopRenderCodeResponse = renderResponse;
  window.dispatchEvent(new Event("ditto-desktop-code-renderer-ready"));
  onCleanup(() => {
    if (host.dittoDesktopRenderCodeResponse === renderResponse)
      delete host.dittoDesktopRenderCodeResponse;
    for (const response of responses.values()) response.dispose();
    responses.clear();
  });
}

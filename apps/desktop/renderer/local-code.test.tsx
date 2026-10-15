import { createContext, useContext } from "solid-js";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { registerDesktopCodeRenderer } from "./local-code";

const RenderOwner = createContext("missing");
const observedOwners: string[] = [];
const copy = vi.hoisted(() => vi.fn(async (_text: string) => true));
vi.mock("@/hooks/useArtifactViewer", () => ({
  useArtifactViewer: () => {
    observedOwners.push(useContext(RenderOwner));
    return { viewArtifact: vi.fn() };
  },
}));
vi.mock("@/hooks/useMemoryViewer", () => ({ useMemoryViewer: () => ({ viewMemory: vi.fn() }) }));
vi.mock("@/hooks/useSubjectViewer", () => ({
  useSubjectViewer: () => ({ viewSubjectById: vi.fn() }),
}));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: copy }));
vi.mock("@/lib/haptics", () => ({ HapticPattern: { Light: "light" }, triggerHaptic: vi.fn() }));

type RendererHost = Window & {
  dittoDesktopRenderCodeResponse?: (target: HTMLElement, source: string | null) => void;
};
const host = window as RendererHost;
const targets: HTMLElement[] = [];
const Registration = () => {
  registerDesktopCodeRenderer();
  return null;
};
function mount() {
  const component = render(() => (
    <RenderOwner.Provider value="code-provider">
      <Registration />
    </RenderOwner.Provider>
  ));
  const target = document.createElement("div");
  document.body.append(target);
  targets.push(target);
  return { ...component, target };
}
afterEach(() => {
  for (const target of targets.splice(0)) target.remove();
  observedOwners.length = 0;
  copy.mockClear();
});

it("renders streamed local Markdown with the shared owner, sanitization and working code copy", async () => {
  const { target, unmount } = mount();
  const code = 'const title = "café ✓";';
  host.dittoDesktopRenderCodeResponse!(target, "## Local result\n\n**Ready**");
  expect(target.querySelector("h2")?.textContent).toBe("Local result");
  expect(target.querySelector("strong")?.textContent).toBe("Ready");
  host.dittoDesktopRenderCodeResponse!(
    target,
    `## Local result\n\n**Ready**\n\n\`\`\`js\n${code}\n\`\`\`\n\n<script>alert(1)</script><a href="javascript:alert(1)">Unsafe</a>`,
  );
  await waitFor(() => expect(target.querySelector("pre code")?.textContent?.trimEnd()).toBe(code));
  expect(target.querySelector("script")).toBeNull();
  expect(target.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(observedOwners).toEqual(["code-provider"]);
  const button = target.querySelector<HTMLButtonElement>(".code-copy-button, .copy-button");
  expect(button).not.toBeNull();
  fireEvent.click(button!);
  await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining(code)));
  unmount();
  expect(host.dittoDesktopRenderCodeResponse).toBeUndefined();
  expect(target.childNodes.length).toBe(0);
});

it("releases replaced replies and registers again without retaining the previous task", () => {
  const first = mount();
  host.dittoDesktopRenderCodeResponse!(first.target, "Old reply");
  expect(first.target.textContent?.trim()).toBe("Old reply");
  host.dittoDesktopRenderCodeResponse!(first.target, null);
  expect(first.target.childNodes.length).toBe(0);
  first.unmount();
  const second = mount();
  host.dittoDesktopRenderCodeResponse!(second.target, "New reply");
  expect(second.target.textContent?.trim()).toBe("New reply");
  expect(first.target.childNodes.length).toBe(0);
  second.unmount();
});

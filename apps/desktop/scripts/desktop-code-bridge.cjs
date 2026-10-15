// The bundled web composer remains the single input for local and cloud tasks.
// These narrow build overlays are restored after compilation; the submodule stays pinned.
function codeComposerOverlay(source) {
  const anchor = "  if (!starter) {";
  if (!source.includes(anchor) || !source.includes("export const codeTaskDraft = draft"))
    throw new Error("The upstream Code composer changed; review the desktop bridge.");
  source = source.replace(
    "export function startCodeTaskFromComposer(",
    "export async function startCodeTaskFromComposer(",
  );
  source = source.replace("import { createSignal }", "import { createMemo, createSignal }");
  source = source.replace(
    anchor,
    `  const desktop = (globalThis as typeof globalThis & { dittoDesktopStartCode?: (input: CodeTaskStartInput) => Promise<CodeTaskStartResult | null> }).dittoDesktopStartCode
  if (import.meta.env.VITE_DITTO_DESKTOP && desktop) {
    const result = await desktop(input)
    if (result) return result
  }
${anchor}`,
  );
  return source.replace(
    "export const codeTaskDraft = draft\nexport const setCodeTaskDraft = setDraft",
    `const [desktopLocal, setDesktopLocal] = createSignal(false)
const [localDraft, setLocalDraft] = createSignal("")
if (import.meta.env.VITE_DITTO_DESKTOP && typeof window !== "undefined") {
  window.addEventListener("ditto-desktop-execution-mode", (event) => {
    const detail = (event as CustomEvent<{ local: boolean; prompt?: string }>).detail
    setDesktopLocal(detail.local)
    if (typeof detail.prompt === "string") setLocalDraft(detail.prompt)
  })
}
export const desktopCodeLocal = desktopLocal
export const codeTaskDraft = createMemo(() => desktopLocal() ? localDraft() : draft())
export const setCodeTaskDraft = (value: string): string => desktopLocal() ? setLocalDraft(value) : setDraft(value)`,
  );
}
function codeModeOverlay(source) {
  const anchor = "!selectedCodeTask(uid, kgID)";
  if (!source.includes(anchor))
    throw new Error("The upstream Code mode state changed; review the desktop bridge.");
  return (
    'import { desktopCodeLocal } from "./codeComposer"\n' +
    source.replace(anchor, "(desktopCodeLocal() || !selectedCodeTask(uid, kgID))")
  );
}
function codeSurfaceOverlay(source) {
  const anchor = "  const t = useT()";
  if (!source.includes(anchor) || !source.includes("export function V2CodeSurface"))
    throw new Error("The upstream Code surface changed; review the desktop renderer.");
  return (
    'import { registerDesktopCodeRenderer } from "@/desktop/local-code"\n' +
    source.replace(
      anchor,
      `  if (import.meta.env.VITE_DITTO_DESKTOP) registerDesktopCodeRenderer()\n${anchor}`,
    )
  );
}
module.exports = { codeComposerOverlay, codeModeOverlay, codeSurfaceOverlay };

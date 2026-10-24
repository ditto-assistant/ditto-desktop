function replace(source, anchor, replacement) {
  if (!source.includes(anchor) || source.indexOf(anchor) !== source.lastIndexOf(anchor))
    throw new Error("Desktop computer bridge needs review after the web app changed.");
  return source.replace(anchor, replacement);
}
const metadataImport = 'import { desktopComputerMetadata } from "@/desktop/desktopComputer"\n';

module.exports = {
  appOverlay: (source) =>
    replace(
      'import DesktopComputerController from "@/desktop/DesktopComputerController"\n' + source,
      "<NativeNotificationsController />",
      "<DesktopComputerController /><NativeNotificationsController />",
    ),
  composerOverlay: (source) =>
    replace(
      metadataImport + source,
      ") => ({\n  input,",
      ") => ({\n  ...desktopComputerMetadata(),\n  input,",
    ),
  promptOverlay: (source) =>
    replace(
      metadataImport + source,
      "const body: Record<string, unknown> = {\n      userID:",
      "const body: Record<string, unknown> = {\n      ...desktopComputerMetadata(),\n      userID:",
    ),
};

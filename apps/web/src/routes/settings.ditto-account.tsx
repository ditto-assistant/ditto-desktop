import { createFileRoute } from "@tanstack/react-router";

import { DittoAccountSettingsPanel } from "../components/settings/DittoAccountSettings";

function SettingsDittoAccountRoute() {
  return <DittoAccountSettingsPanel />;
}

export const Route = createFileRoute("/settings/ditto-account")({
  component: SettingsDittoAccountRoute,
});

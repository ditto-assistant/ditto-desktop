import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const environmentState = vi.hoisted(() => ({
  primaryId: null as string | null,
  environments: [] as Array<{ environmentId: string }>,
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => environmentState.primaryId,
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: environmentState.environments,
    presentationById: new Map(),
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

vi.mock("../../localApi", () => ({
  readLocalApi: () => null,
}));

vi.mock("~/ditto/account", () => ({
  dittoAccountCommands: { getStatus: {}, link: {}, unlink: {} },
}));

vi.mock("./settingsLayout", () => ({
  SettingsRow: ({
    description,
    control,
    children,
  }: {
    description?: unknown;
    control?: unknown;
    children?: unknown;
  }) => (
    <div data-testid="row">
      <div>{description as never}</div>
      <div>{control as never}</div>
      <div>{children as never}</div>
    </div>
  ),
}));

import { DeviceLinkRow } from "./DittoDeviceLink";

afterEach(() => {
  environmentState.primaryId = null;
  environmentState.environments = [];
});

describe("DeviceLinkRow", () => {
  it("shows the Link button when an environment is connected", () => {
    environmentState.primaryId = "env-local";
    environmentState.environments = [{ environmentId: "env-local" }];
    const html = renderToStaticMarkup(<DeviceLinkRow initialStatus={{ linked: false }} />);
    expect(html).toContain("Link this computer");
    expect(html).not.toContain("Waiting for a desktop server");
  });

  it("follows a relay-only registry when no primary environment exists", () => {
    environmentState.environments = [{ environmentId: "env-relay" }];
    const html = renderToStaticMarkup(<DeviceLinkRow initialStatus={{ linked: false }} />);
    expect(html).toContain("Link this computer");
  });

  it("shows the linked state with the key hint", () => {
    environmentState.primaryId = "env-local";
    const html = renderToStaticMarkup(
      <DeviceLinkRow initialStatus={{ linked: true, keyHint: "9f3a" }} />,
    );
    expect(html).toContain("…9f3a");
    expect(html).toContain("Disconnect");
  });

  it("explains the dead end only when no environment is registered", () => {
    const html = renderToStaticMarkup(<DeviceLinkRow />);
    expect(html).toContain("Waiting for a desktop server");
    expect(html).not.toContain("Link this computer to your Ditto account");
  });
});

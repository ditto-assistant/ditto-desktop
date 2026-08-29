import type { ConnectedChannelAccount, EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

interface ChannelAccountConnectionState {
  readonly configuredByEnvironment: Readonly<Record<string, ConnectedChannelAccount>>;
  readonly setConfigured: (environmentId: EnvironmentId, account: ConnectedChannelAccount) => void;
  readonly clearConfigured: (environmentId: EnvironmentId) => void;
}

export const useChannelAccountConnectionStore = create<ChannelAccountConnectionState>((set) => ({
  configuredByEnvironment: {},
  setConfigured: (environmentId, account) =>
    set((state) => ({
      configuredByEnvironment: {
        ...state.configuredByEnvironment,
        [environmentId]: account,
      },
    })),
  clearConfigured: (environmentId) =>
    set((state) => {
      const { [environmentId]: _, ...remaining } = state.configuredByEnvironment;
      return { configuredByEnvironment: remaining };
    }),
}));

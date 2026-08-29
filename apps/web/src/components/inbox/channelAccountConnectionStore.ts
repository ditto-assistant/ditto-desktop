import type { ConnectedChannelAccount, EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

interface ChannelAccountConnectionState {
  readonly accountsByEnvironment: Readonly<Record<string, ReadonlyArray<ConnectedChannelAccount>>>;
  readonly setAccounts: (
    environmentId: EnvironmentId,
    accounts: ReadonlyArray<ConnectedChannelAccount>,
  ) => void;
  readonly upsertAccount: (environmentId: EnvironmentId, account: ConnectedChannelAccount) => void;
}

export const useChannelAccountConnectionStore = create<ChannelAccountConnectionState>((set) => ({
  accountsByEnvironment: {},
  setAccounts: (environmentId, accounts) =>
    set((state) => ({
      accountsByEnvironment: {
        ...state.accountsByEnvironment,
        [environmentId]: accounts,
      },
    })),
  upsertAccount: (environmentId, account) =>
    set((state) => {
      const current = state.accountsByEnvironment[environmentId] ?? [];
      return {
        accountsByEnvironment: {
          ...state.accountsByEnvironment,
          [environmentId]: [
            ...current.filter((candidate) => candidate.accountId !== account.accountId),
            account,
          ],
        },
      };
    }),
}));

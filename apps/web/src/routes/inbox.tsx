import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";
import { normalizeInboxSearchValue } from "./-inboxSearch";

export const Route = createFileRoute("/inbox")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { account?: string; conversation?: string } => {
    const account = normalizeInboxSearchValue(search.account);
    const conversation = normalizeInboxSearchValue(search.conversation);
    return {
      ...(account !== undefined ? { account } : {}),
      ...(conversation !== undefined ? { conversation } : {}),
    };
  },
  component: InboxRoute,
});

function InboxRoute() {
  const search = Route.useSearch();
  return <InboxPage accountId={search.account} conversationId={search.conversation} />;
}

import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";

export const Route = createFileRoute("/inbox")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { account?: string; conversation?: string } => ({
    ...(typeof search.account === "string" ? { account: search.account } : {}),
    ...(typeof search.conversation === "string" ? { conversation: search.conversation } : {}),
  }),
  component: InboxRoute,
});

function InboxRoute() {
  const search = Route.useSearch();
  return <InboxPage accountId={search.account} conversationId={search.conversation} />;
}

import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";

export const Route = createFileRoute("/inbox")({
  component: InboxPage,
});

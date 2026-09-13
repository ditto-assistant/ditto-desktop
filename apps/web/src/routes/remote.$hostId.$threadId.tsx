import { createFileRoute } from "@tanstack/react-router";

import { RemoteSessionView } from "../components/ditto/RemoteSessionView";

export const Route = createFileRoute("/remote/$hostId/$threadId")({
  component: RemoteSessionRoute,
});

function RemoteSessionRoute() {
  const { hostId, threadId } = Route.useParams();
  return <RemoteSessionView hostId={hostId} threadId={threadId} />;
}

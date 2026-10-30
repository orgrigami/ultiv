import { createFileRoute, redirect } from "@tanstack/react-router";

/** Connectors merged into the Tools page. */
export const Route = createFileRoute("/connectors")({
  beforeLoad: () => {
    throw redirect({ to: "/tools", search: {}, replace: true });
  },
});

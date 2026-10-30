import { createFileRoute, redirect } from "@tanstack/react-router";

/** Skills merged into the Tools page. */
export const Route = createFileRoute("/skills")({
  beforeLoad: () => {
    throw redirect({ to: "/tools", search: { tab: "skills" }, replace: true });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

/** Vault merged into the Tools page. */
export const Route = createFileRoute("/vault")({
  beforeLoad: () => {
    throw redirect({ to: "/tools", search: { tab: "vault" }, replace: true });
  },
});

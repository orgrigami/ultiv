import { createFileRoute, redirect } from "@tanstack/react-router";
import { MOVED } from "../lib/nav.ts";

/** Needs you is the top of Now (older pushes and bookmarks still link here). */
export const Route = createFileRoute("/needs")({
  beforeLoad: () => {
    throw redirect({ to: MOVED["/needs"], replace: true });
  },
});

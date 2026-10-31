import { createFileRoute, redirect } from "@tanstack/react-router";
import { MOVED } from "../lib/nav.ts";

/** The old Bots page is now Crew (the memory-tidy push still links here). */
export const Route = createFileRoute("/bots")({
  beforeLoad: () => {
    throw redirect({ to: MOVED["/bots"], replace: true });
  },
});

import { createFileRoute, redirect } from "@tanstack/react-router";

/** Teams were called departments: old links and bookmarks land on the team page. */
export const Route = createFileRoute("/crew/dept/$departmentId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/crew/team/$teamId",
      params: { teamId: params.departmentId },
      replace: true,
    });
  },
});

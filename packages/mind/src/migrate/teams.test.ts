import { describe, expect, it } from "vite-plus/test";
import { parseLines } from "../audit/tail.ts";
import { teamIdOfSegment } from "../org/model.ts";
import { ProfilesDoc } from "../profiles/docs.ts";
import { renameLegacyTeams, renameTeamTool } from "./teams.ts";

describe("teams were departments", () => {
  it("moves keys, home kinds and tool names, never ids", () => {
    const stored = {
      departments: [{ id: "dept-design", name: "Design" }],
      members: [{ departmentId: "dept-design", role: "admin" }],
      grants: [{ home: { kind: "department", departmentId: "dept-design" } }],
      profiles: [
        {
          id: "b1",
          departmentId: "dept-design",
          toolAllowlist: ["departments_list", "department_create", "web_search"],
          policies: { autoApprove: ["department_update:*", "bash"] },
        },
      ],
      facts: [{ scope: "department", text: "the department meets on Mondays" }],
    };
    expect(renameLegacyTeams(stored)).toEqual({
      teams: [{ id: "dept-design", name: "Design" }],
      members: [{ teamId: "dept-design", role: "admin" }],
      grants: [{ home: { kind: "team", teamId: "dept-design" } }],
      profiles: [
        {
          id: "b1",
          teamId: "dept-design",
          toolAllowlist: ["teams_list", "team_create", "web_search"],
          policies: { autoApprove: ["team_update:*", "bash"] },
        },
      ],
      // Words inside text are the owner's and the bots': left as written.
      facts: [{ scope: "team", text: "the department meets on Mondays" }],
    });
  });

  it("keeps a row already written with the new name", () => {
    expect(renameLegacyTeams({ teamId: "new", departmentId: "old" })).toEqual({ teamId: "new" });
    expect(renameTeamTool("memory_write")).toBe("memory_write");
  });

  it("reads old connector segments as their team", () => {
    expect(teamIdOfSegment("team-dept-a")).toBe("dept-a");
    expect(teamIdOfSegment("dept-dept-a")).toBe("dept-a");
    expect(teamIdOfSegment("org")).toBeUndefined();
  });

  it("reads old audit lines with the new names", () => {
    const [change, write] = parseLines([
      JSON.stringify({ kind: "permission", name: "department-created", profile: null }),
      JSON.stringify({
        kind: "permission",
        name: "x",
        sharedWrite: {
          path: "/home/dept-shared/a/f",
          bytes: 1,
          area: "dept-shared",
          departmentId: "a",
        },
      }),
    ]);
    expect(change?.name).toBe("team-created");
    expect(write?.sharedWrite).toEqual({
      path: "/home/dept-shared/a/f",
      bytes: 1,
      area: "team-shared",
      teamId: "a",
    });
  });

  it("upgrades stored profiles without reopening a locked bot", () => {
    type Rows = { profiles: { teamId?: string; policies: { canInitiate: string[] } }[] };
    const row = { id: "b1", departmentId: "dept-ops", policies: { canInitiate: [] } };
    const migrate = ProfilesDoc.definition.migrate!;
    // A v2 row: an empty list is the owner's deliberate lock and stays one.
    const fromV2 = migrate({ profiles: [row] } as never, 2) as unknown as Rows;
    expect(fromV2.profiles[0]).toMatchObject({ teamId: "dept-ops", policies: { canInitiate: [] } });
    // A v1 row still gets the open default the v2 migration gave it.
    const fromV1 = migrate({ profiles: [row] } as never, 1) as unknown as Rows;
    expect(fromV1.profiles[0]?.policies.canInitiate).toEqual(["*"]);
  });
});

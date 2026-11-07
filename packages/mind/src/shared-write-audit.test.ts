/**
 * Fix 2 audit: an org bot's writes into org-shared or a team store,
 * reported by ext after a bash call, become one audit row per file (path,
 * size, area, team, the writing bot) — never content, at most 50.
 */
import { describe, expect, it } from "vite-plus/test";
import { Duration, Effect } from "effect";
import type { AuditEvent } from "@spriessen/contracts";
import type { ScopeResolver, ScopeHolder } from "@spriessen/ext";
import { makeApprovals } from "./approvals.ts";
import { wirePolicies } from "./entity-parts.ts";

describe("shared-write audit rows", () => {
  it("records path, bytes, area, team and the bot", () => {
    let resolver: ScopeResolver | undefined;
    const audit: AuditEvent[] = [];
    wirePolicies(
      { set: (r: ScopeResolver) => (resolver = r) } as unknown as ScopeHolder,
      makeApprovals(Duration.seconds(30), Duration.seconds(8)),
      { record: (event: AuditEvent) => audit.push(event) } as never,
      {
        profileOf: () => ({ id: "bot-org", teamId: null }),
        scopeOf: () => undefined,
      } as never,
      { available: false } as never,
      { entriesOf: () => Effect.succeed([]) } as never,
    );
    resolver?.sharedWrite?.("conv-1", [
      {
        path: "/home/team-shared/research/a.txt",
        bytes: 9,
        area: "team-shared",
        teamId: "research",
      },
      ...Array.from({ length: 60 }, (_, i) => ({
        path: `/home/org-shared/f${i}`,
        bytes: i,
        area: "org-shared" as const,
        teamId: null,
      })),
    ]);
    expect(audit).toHaveLength(50);
    expect(audit[0]).toMatchObject({
      kind: "shared_write",
      conversationId: "conv-1",
      profile: "bot-org",
      sharedWrite: {
        path: "/home/team-shared/research/a.txt",
        bytes: 9,
        area: "team-shared",
        teamId: "research",
      },
    });
  });
});

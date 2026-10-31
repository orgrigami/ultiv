import { describe, expect, it } from "vite-plus/test";
import type { AuditEvent, MemoryProposal } from "@ultiv/contracts";
import { ESCALATION_WINDOW_MS, needsYouExtra } from "./needs-you.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3_600_000;

const proposal = (over: Partial<MemoryProposal>): MemoryProposal => ({
  id: "p",
  kind: "merge",
  at: NOW - DAY,
  factIds: [],
  summary: "Two facts say the same thing",
  fingerprint: "f",
  status: "open",
  decidedAt: null,
  ...over,
});

const event = (over: Partial<AuditEvent>): AuditEvent =>
  ({
    at: NOW - DAY,
    kind: "escalation",
    conversationId: "c1",
    profile: "bot-a",
    callId: null,
    name: "Routine stopped",
    durationMs: null,
    ok: false,
    error: null,
    ...over,
  }) as AuditEvent;

describe("needsYouExtra", () => {
  it("counts only open, visible tidy proposals and drops bots with none", () => {
    const out = needsYouExtra({
      proposals: new Map([
        [
          "bot-a",
          [
            proposal({ id: "1" }),
            proposal({ id: "2", status: "accepted" }),
            proposal({ id: "3", at: NOW - 40 * DAY }),
          ],
        ],
        ["bot-b", [proposal({ id: "4", status: "rejected" })]],
      ]),
      audit: [],
      profiles: new Set(["bot-a", "bot-b"]),
      now: NOW,
    });
    expect(out.tidy).toEqual([{ profile: "bot-a", open: 1 }]);
  });

  it("keeps recent escalations for the owner's bots, newest first", () => {
    const out = needsYouExtra({
      proposals: new Map(),
      audit: [
        event({ at: NOW - ESCALATION_WINDOW_MS - 1, name: "too old" }),
        event({ at: NOW - 2 * DAY, name: "older" }),
        event({ kind: "tool_call", name: "not an escalation" }),
        event({ profile: "someone-else", name: "other owner" }),
        event({ profile: null, name: "unmapped" }),
        event({ at: NOW - DAY, name: "newer" }),
      ],
      profiles: new Set(["bot-a"]),
      now: NOW,
    });
    expect(out.escalations.map((e) => e.name)).toEqual(["newer", "older"]);
  });
});

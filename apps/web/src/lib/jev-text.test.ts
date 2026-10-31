import { describe, expect, it } from "vite-plus/test";
import type { AuditEvent } from "@spreissen/contracts";
import { jevNotice, jevNotices } from "./jev-text";

const event = (ok: boolean | null, error: string, callId = "c1"): AuditEvent => ({
  at: 0,
  kind: "adjudication",
  conversationId: "conv",
  profile: "p1",
  callId,
  name: "run",
  durationMs: null,
  ok,
  error,
});

describe("jevNotice", () => {
  it("tells the four outcomes apart", () => {
    expect(jevNotice(event(true, "looks routine (0.91)"))).toEqual({
      kind: "approved",
      title: "Jev approved: run",
      reason: "looks routine (0.91)",
    });
    expect(jevNotice(event(false, "looks outside what you delegated (0.05)"))?.kind).toBe("denied");
    const split = jevNotice(
      event(
        false,
        "too complex to judge: split into smaller steps — 4 chained commands in one call",
      ),
    );
    expect(split?.kind).toBe("split");
    expect(split?.reason).toBe("4 chained commands in one call");
    const destructive = jevNotice(
      event(
        false,
        "destructive and not justified by the request: explain why or ask the user first — git reset --hard",
      ),
    );
    expect(destructive?.kind).toBe("destructive");
    expect(destructive?.reason).toBe("git reset --hard");
  });

  it("skips non-decisions and keys by call id", () => {
    expect(jevNotice(event(null, "timed out"))).toBeNull();
    const map = jevNotices([event(false, "x", "a"), event(true, "y", "b")]);
    expect([...map.keys()]).toEqual(["a", "b"]);
  });
});

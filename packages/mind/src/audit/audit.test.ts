import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeAudit } from "./audit.ts";
import type { AuditEvent } from "@spriessen/contracts";

const event = (at: number, name: string): AuditEvent => ({
  at,
  kind: "tool_call",
  conversationId: "c1",
  profile: null,
  callId: `call-${at}`,
  name,
  durationMs: 5,
  ok: true,
  error: null,
});

const dirs: string[] = [];
const tempFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-audit-"));
  dirs.push(dir);
  return join(dir, "audit.jsonl");
};

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("Audit (JSONL)", () => {
  it("appends events and tails the most recent ones", () => {
    const path = tempFile();
    const audit = makeAudit(path);
    audit.record(event(1, "now"));
    audit.record(event(2, "web_search"));
    audit.record(event(3, "artifact_write"));
    const tail = audit.tail(2);
    expect(tail.map((entry) => entry.name)).toEqual(["web_search", "artifact_write"]);
  });

  it("tails nothing from a missing file and survives a corrupt line", () => {
    const path = tempFile();
    const audit = makeAudit(path);
    expect(audit.tail(10)).toEqual([]);
    writeFileSync(path, "{not json}\n");
    audit.record(event(1, "now"));
    expect(audit.tail(10).map((entry) => entry.name)).toEqual(["now"]);
  });

  it("tails a large file from the end, whole lines only", () => {
    const path = tempFile();
    // Multi-byte names and lines long enough to straddle the 64 KB chunks.
    const lines = Array.from({ length: 3_000 }, (_, i) =>
      JSON.stringify({ ...event(i, `tool-${i}-ü-🌱`), error: "x".repeat(i % 97) }),
    );
    writeFileSync(path, `${lines.join("\n")}\n`);
    const audit = makeAudit(path);
    expect(audit.tail(3).map((entry) => entry.at)).toEqual([2_997, 2_998, 2_999]);
    expect(audit.tail(2_000).map((entry) => entry.at)).toEqual(
      Array.from({ length: 2_000 }, (_, i) => 1_000 + i),
    );
    expect(audit.tail(10_000)).toHaveLength(3_000);
    expect(audit.tail(0)).toEqual([]);
  });

  it("tails a file without a trailing newline", () => {
    const path = tempFile();
    writeFileSync(path, [1, 2, 3].map((at) => JSON.stringify(event(at, "now"))).join("\n"));
    expect(
      makeAudit(path)
        .tail(2)
        .map((entry) => entry.at),
    ).toEqual([2, 3]);
  });

  it("keeps each conversation's recent events apart", () => {
    const path = tempFile();
    const audit = makeAudit(path);
    audit.record(event(1, "web_fetch"));
    audit.record({ ...event(2, "now"), conversationId: "c2" });
    expect(audit.ofConversation("c1").map((entry) => entry.name)).toEqual(["web_fetch"]);
    expect(audit.ofConversation("c2").map((entry) => entry.name)).toEqual(["now"]);
    expect(audit.ofConversation("nope")).toEqual([]);
  });
});

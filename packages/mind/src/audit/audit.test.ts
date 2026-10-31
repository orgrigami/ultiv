import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { makeAudit } from "./audit.ts";
import type { AuditEvent } from "@spreissen/contracts";

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
  const dir = mkdtempSync(join(tmpdir(), "spreissen-audit-"));
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
});

import { describe, expect, it } from "vite-plus/test";
import {
  appearsInOwnerInput,
  checkContent,
  contextOf,
  coreVerdict,
  looksLikeInstruction,
  originOfPrefix,
  policyFor,
  trustFor,
} from "./guard.ts";
import type { AuditEvent } from "@spreissen/contracts";
import { Effect } from "effect";
import type { AuditService } from "../audit/audit.ts";
import type { ConverseService } from "../converse/converse.ts";

// Minimal fakes: entriesOf is NEWEST FIRST (pi-durable scan order).
const entry = (
  id: number,
  messages: readonly { role: "user" | "assistant"; content: string; timestamp: number }[],
) => ({ id, conversationId: 7, kind: "model", model: messages });

const auditEvent = (at: number, name: string): AuditEvent => ({
  at,
  kind: "tool_call",
  conversationId: "c1",
  profile: null,
  callId: null,
  name,
  durationMs: null,
  ok: true,
  error: null,
});

const contextDeps = (
  entries: readonly ReturnType<typeof entry>[],
  events: readonly AuditEvent[],
): Parameters<typeof contextOf>[0] => ({
  converse: {
    entriesOf: () => Effect.succeed(entries),
  } as unknown as ConverseService,
  audit: { tail: () => events } as unknown as AuditService,
});

describe("origin detection", () => {
  it("maps the protected bracket prefixes and plain owner input", () => {
    expect(originOfPrefix("[cron nightly] do the thing")).toBe("cron");
    expect(originOfPrefix("[webhook gh] payload")).toBe("webhook");
    expect(originOfPrefix("[sensor cal] event")).toBe("sensor");
    expect(originOfPrefix("[message from Iris • dm] please")).toBe("bot");
    expect(originOfPrefix("[task t1 finished] done")).toBe("task");
    expect(originOfPrefix("[owner] note")).toBe("owner");
    expect(originOfPrefix("plain owner words")).toBe("owner");
    expect(originOfPrefix("[unknown prefix] junk")).toBe("unknown");
  });
});

describe("policy by origin", () => {
  it("owner untainted: full trust, instructions allowed", () => {
    const policy = policyFor({ origin: "owner", tainted: false, ownerInput: null });
    expect(policy.allowInstructions).toBe(true);
    expect(policy.maxTrust).toBe("owner");
  });
  it("owner tainted: derived, no instructions, no owner scope", () => {
    const policy = policyFor({ origin: "owner", tainted: true, ownerInput: "x" });
    expect(policy.trust).toBe("derived");
    expect(policy.allowInstructions).toBe(false);
    expect(policy.allowOwnerScope).toBe(false);
  });
  it("cron/task: self, no instructions; outside: untrusted profile-only", () => {
    expect(policyFor({ origin: "cron", tainted: false, ownerInput: null }).maxTrust).toBe("self");
    expect(policyFor({ origin: "task", tainted: false, ownerInput: null }).allowInstructions).toBe(
      false,
    );
    const outside = policyFor({ origin: "webhook", tainted: false, ownerInput: null });
    expect(outside.maxTrust).toBe("untrusted");
    expect(outside.allowOwnerScope).toBe(false);
  });
  it("trust ceilings clamp the requested trust", () => {
    expect(trustFor("owner", policyFor({ origin: "cron", tainted: false, ownerInput: null }))).toBe(
      "self",
    );
    expect(trustFor("self", policyFor({ origin: "owner", tainted: false, ownerInput: null }))).toBe(
      "self",
    );
  });
});

describe("content checks", () => {
  it("refuses API keys, JWTs, private keys, cards, NIK and OTPs", () => {
    expect(checkContent("my key is sk-abcdefghijklmnopqrstuvwx").ok).toBe(false);
    expect(
      checkContent(
        "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
      ).ok,
    ).toBe(false);
    expect(checkContent("-----BEGIN RSA PRIVATE KEY-----").ok).toBe(false);
    expect(checkContent("card 4532015112830366 for billing").ok).toBe(false);
    expect(checkContent("NIK 3175012345670002").ok).toBe(false);
    expect(checkContent("otp 482913").ok).toBe(false);
    expect(checkContent("password=hunter2scrambled").ok).toBe(false);
  });
  it("lets plain facts through", () => {
    expect(checkContent("harry prefers tea over coffee").ok).toBe(true);
    expect(checkContent("the cat's vet visit is on Friday").ok).toBe(true);
  });
});

describe("turn context (origin + taint window)", () => {
  const user = (content: string, timestamp: number) => ({
    role: "user" as const,
    content,
    timestamp,
  });

  it("reads origin from the NEWEST user entry", async () => {
    const context = await contextOf(
      contextDeps(
        [
          entry(20, [user("[cron nightly] run the sweep", 2_000)]),
          entry(10, [user("plain owner words", 1_000)]),
        ],
        [],
      ),
      "c1",
    );
    expect(context.origin).toBe("cron");
    // Only an owner-voiced CURRENT input counts as ownerInput — the
    // tainted-instruction exception needs this turn's owner words.
    expect(context.ownerInput).toBe(null);
    const owner = await contextOf(
      contextDeps([entry(30, [user("plain owner words", 3_000)])], []),
      "c1",
    );
    expect(owner.origin).toBe("owner");
    expect(owner.ownerInput).toBe("plain owner words");
  });

  it("taints only tools that ran AT OR AFTER the current input", async () => {
    const entries = [entry(20, [user("summarise this page", 5_000)])];
    const before = await contextOf(contextDeps(entries, [auditEvent(4_999, "web_fetch")]), "c1");
    expect(before.tainted).toBe(false);
    const after = await contextOf(contextDeps(entries, [auditEvent(5_000, "web_fetch")]), "c1");
    expect(after.tainted).toBe(true);
  });

  it("ignores untrusted tools from other conversations", async () => {
    const entries = [entry(20, [user("hello", 5_000)])];
    const elsewhere = auditEvent(9_000, "web_fetch");
    const context = await contextOf(
      contextDeps(entries, [{ ...elsewhere, conversationId: "other" }]),
      "c1",
    );
    expect(context.tainted).toBe(false);
  });
});

describe("core-line verdicts", () => {
  const base = { ownerInput: null };
  it("allows a clean owner turn with plain text", () => {
    const verdict = coreVerdict({ ...base, origin: "owner", tainted: false }, "harry prefers tea");
    expect(verdict.ok).toBe(true);
  });
  it("refuses automated origins, tainted turns and secrets", () => {
    for (const origin of ["webhook", "sensor", "cron", "task", "bot", "unknown"] as const) {
      expect(
        coreVerdict({ ...base, origin, tainted: false }, "always greet politely").ok,
        origin,
      ).toBe(false);
    }
    expect(coreVerdict({ ...base, origin: "owner", tainted: true }, "plain text").ok).toBe(false);
    expect(
      coreVerdict({ ...base, origin: "owner", tainted: false }, "key is sk-fakefakefakefake123").ok,
    ).toBe(false);
  });
});

describe("instruction shapes", () => {
  it("flags imperative standing orders but not plain facts", () => {
    expect(looksLikeInstruction("Always address Harry as Boss")).toBe(true);
    expect(looksLikeInstruction("jangan lupa kirim laporan tiap Jumat")).toBe(true);
    expect(looksLikeInstruction("harry's cat is named oren")).toBe(false);
  });
  it("the tainted-owner exception needs the owner's own words", () => {
    expect(
      appearsInOwnerInput("always address Harry as Boss", "please always address Harry as Boss"),
    ).toBe(true);
    expect(appearsInOwnerInput("always address Harry as Boss", "unrelated words")).toBe(false);
    expect(appearsInOwnerInput("always address Harry as Boss", null)).toBe(false);
  });
});

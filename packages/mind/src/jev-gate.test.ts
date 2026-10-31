import { describe, expect, it } from "vite-plus/test";
import { Duration, Effect } from "effect";
import type { AuditEvent, ProfileApprovalMode, TranscriptEntry } from "@spreissen/contracts";
import { FIRST_USE_APPROVAL, type ScopeHolder } from "@spreissen/ext";
import { makeApprovals, type ApprovalRequest } from "./approvals.ts";
import { wirePolicies } from "./entity-parts.ts";
import {
  DESTRUCTIVE_PREFIX,
  MAX_CONTEXT_CHARS,
  SPLIT_PREFIX,
  buildContext,
  complexityOf,
  destructiveOf,
  makeAdjudicator,
  JEV_COMPLEX_RUBRIC,
  opaqueOf,
} from "./jev-gate.ts";

const call = (name: string, input: unknown = {}, callId = `c-${name}`): ApprovalRequest => ({
  callId,
  name,
  input,
});

/** The real approvals broker wired through wirePolicies with fakes around it. */
const rig = (opts: {
  mode: ProfileApprovalMode;
  autoApprove?: string[];
  probability?: number;
  complexity?: number;
  hang?: boolean;
  transcript?: TranscriptEntry[];
  adjudicateTimeout?: Duration.Duration;
}) => {
  const approvals = makeApprovals(
    Duration.seconds(30),
    opts.adjudicateTimeout ?? Duration.seconds(8),
  );
  const audit: AuditEvent[] = [];
  const asked: string[] = [];
  const profile = {
    id: "p1",
    name: "Nova",
    description: "test bot",
    policies: { approvalMode: opts.mode, autoApprove: opts.autoApprove ?? ([] as string[]) },
  };
  const decide = {
    available: true,
    yesNo: (state: unknown, rubric: string) => {
      asked.push(String(state));
      if (opts.hang === true) return Effect.never;
      return Effect.succeed(
        rubric.startsWith("Is this single tool call too complex")
          ? (opts.complexity ?? 0)
          : (opts.probability ?? 0.5),
      );
    },
  };
  wirePolicies(
    { set: () => {} } as unknown as ScopeHolder,
    approvals,
    { record: (event: AuditEvent) => audit.push(event) } as never,
    { profileOf: () => profile, scopeOf: () => undefined } as never,
    decide as never,
    { entriesOf: () => Effect.succeed([]) } as never,
  );
  // The transcript seam goes through projectTranscript of raw entries; tests
  // that need context call buildContext directly, so entriesOf stays empty.
  const run = (request: ApprovalRequest) =>
    Effect.runPromise(approvals.request("conv", request.callId, request));
  /** Resolves "card" once the call parks for the owner, else its boolean outcome. */
  const outcome = async (request: ApprovalRequest): Promise<boolean | "card"> => {
    const pending = run(request);
    for (let i = 0; i < 50; i++) {
      if (approvals.pendingFor("conv").some((p) => p.callId === request.callId)) {
        approvals.decide("conv", request.callId, false);
        await pending;
        return "card";
      }
      const settled = await Promise.race([pending, new Promise((r) => setTimeout(r, 5, "wait"))]);
      if (settled !== "wait") return settled as boolean;
    }
    throw new Error("neither settled nor parked");
  };
  return { approvals, audit, asked, outcome };
};

const FLOORS = [
  "connector_add",
  "connector_update",
  "connector_remove",
  "secret_request",
  FIRST_USE_APPROVAL,
  "mcp (first use of github)",
  "bash_host",
];

describe("jev gate: floors and bash_host", () => {
  for (const probability of [0.99, 0.01]) {
    it(`always produce a card and never consult Jev (fake Jev says ${probability})`, async () => {
      const r = rig({ mode: "jev", probability });
      for (const name of FLOORS) {
        expect(await r.outcome(call(name, { command: "ls" }))).toBe("card");
      }
      expect(r.asked).toEqual([]);
      expect(r.audit).toEqual([]);
    });
  }

  it("a low-risk call is still Jev's (approve high, deny low, audited)", async () => {
    const high = rig({ mode: "jev", probability: 0.95 });
    expect(await high.outcome(call("send_note", { text: "hi" }))).toBe(true);
    expect(high.audit[0]?.ok).toBe(true);
    const low = rig({ mode: "jev", probability: 0.05 });
    expect(await low.outcome(call("send_note", { text: "hi" }))).toBe(false);
    expect(low.audit[0]?.ok).toBe(false);
    expect(low.approvals.noteFor("conv", "c-send_note")).toMatch(/Jev/);
  });
});

describe("autoApprove entries (bare names and tool:glob sub-actions)", () => {
  it("a bare name approves every call of the tool, whatever Jev would say", async () => {
    const r = rig({ mode: "jev", autoApprove: ["bash"], probability: 0.01 });
    expect(await r.outcome(call("bash", { script: "ls -la" }))).toBe(true);
    expect(r.asked).toEqual([]);
  });

  it("a tool:glob entry approves only the matching sub-action (the script field bash sends)", async () => {
    const r = rig({ mode: "jev", autoApprove: ["bash:git *"], probability: 0.01 });
    expect(await r.outcome(call("bash", { script: "git status" }))).toBe(true);
    // A pattern is narrower, never looser: a destructive hit falls to Jev,
    // which denies at 0.01 — so does anything the glob doesn't cover.
    expect(await r.outcome(call("bash", { script: "git push --force" }))).toBe(false);
    expect(await r.outcome(call("bash", { script: "git status && rm -rf /tmp/x" }))).toBe(false);
    expect(await r.outcome(call("bash", { script: "npm test" }))).toBe(false);
    // The destructive and non-matching-first calls are refused deterministically
    // (sent back / glob miss → Jev never scores them); only npm test is scored,
    // and the gate asks both rubrics for it.
    expect(r.asked.length).toBe(2);
  });

  it("a refused pattern match lands on the owner's card in manual mode", async () => {
    const r = rig({ mode: "manual", autoApprove: ["bash:git *"] });
    expect(await r.outcome(call("bash", { script: "git status" }))).toBe(true);
    expect(await r.outcome(call("bash", { script: "git push --force" }))).toBe("card");
    expect(await r.outcome(call("bash", { script: "git status; rm -rf /tmp/x" }))).toBe("card");
    expect(r.asked).toEqual([]);
  });

  it("bash_host never pattern-matches; a bare bash_host entry is still the owner's grant", async () => {
    const patterned = rig({ mode: "manual", autoApprove: ["bash_host:git *"] });
    expect(await patterned.outcome(call("bash_host", { script: "git status" }))).toBe("card");
    const bare = rig({ mode: "manual", autoApprove: ["bash_host"] });
    expect(await bare.outcome(call("bash_host", { script: "git status" }))).toBe(true);
  });

  it("an exact bash_host rule runs that script only; Jev is never asked for bash_host", async () => {
    for (const mode of ["manual", "jev"] as const) {
      const r = rig({ mode, autoApprove: ["bash_host:=git status"], probability: 0.99 });
      expect(await r.outcome(call("bash_host", { script: "git status" })), mode).toBe(true);
      expect(await r.outcome(call("bash_host", { script: "git status; rm -rf x" })), mode).toBe(
        "card",
      );
      expect(await r.outcome(call("bash_host", { script: "git push" })), mode).toBe("card");
      expect(r.asked, mode).toEqual([]);
    }
  });

  it("floors go to the card; nothing was judged or escalated", async () => {
    const r = rig({
      mode: "manual",
      autoApprove: ["secret_request", "secret_request:*", FIRST_USE_APPROVAL],
    });
    for (const name of ["secret_request", FIRST_USE_APPROVAL]) {
      expect(await r.outcome(call(name, { script: "anything" }))).toBe("card");
    }
    expect(r.asked).toEqual([]);
    expect(r.audit).toEqual([]);
  });

  it("yolo still waves everything past the floors, list untouched", async () => {
    const r = rig({ mode: "yolo", autoApprove: [], probability: 0.01 });
    expect(await r.outcome(call("anything", { script: "whatever" }))).toBe(true);
    expect(r.asked).toEqual([]);
  });

  it("a stored rule approves the identical call at the broker (the always-allow round trip)", async () => {
    const r = rig({ mode: "manual", autoApprove: ["bash:npm install"] });
    expect(await r.outcome(call("bash", { script: "npm install" }))).toBe(true);
    expect(await r.outcome(call("bash", { script: "npm install" }))).toBe(true);
    // A different sub-action is not covered by the exact-text rule.
    expect(await r.outcome(call("bash", { script: "npm ci" }))).toBe("card");
    expect(r.asked).toEqual([]);
  });
});

describe("jev gate: timeout", () => {
  it("a hung Jev falls through to the card after the timeout", async () => {
    const r = rig({ mode: "jev", hang: true, adjudicateTimeout: Duration.millis(30) });
    expect(await r.outcome(call("send_note", { text: "hi" }))).toBe("card");
    expect(r.asked.length).toBeGreaterThan(0);
  });
});

describe("yolo is unchanged", () => {
  it("auto-approves everything but the floors; bash_host runs; Jev is never asked", async () => {
    const r = rig({ mode: "yolo", probability: 0.01 });
    expect(await r.outcome(call("bash_host", { command: "rm -rf x" }))).toBe(true);
    expect(await r.outcome(call("artifact_delete", { id: "a" }))).toBe(true);
    for (const name of FLOORS.filter((n) => n !== "bash_host")) {
      expect(await r.outcome(call(name))).toBe("card");
    }
    expect(r.asked).toEqual([]);
  });
});

describe("A: too complex to judge", () => {
  it("flags chaining, substitution and many targets; length is only a hint", () => {
    expect(complexityOf({ command: "ls -la" })).toBeUndefined();
    expect(complexityOf({ command: "a && b && c && d" })).toMatch(/chained/);
    expect(complexityOf({ command: "echo $(cat x)" })).toMatch(/substitution/);
    expect(complexityOf({ command: "x".repeat(500) })).toBeUndefined(); // long is not complex
    expect(complexityOf({ ids: Array.from({ length: 20 }, (_, i) => i) })).toMatch(/targets/);
    expect(complexityOf({ text: "a; b; c; d; e" })).toBeUndefined(); // prose, not a command
    expect(opaqueOf({ command: "x".repeat(500) })[0]).toMatch(/500-character command/);
    expect(opaqueOf({ command: "cat <<'EOF'\nprint('hi')\nEOF" })[0]).toMatch(/heredoc/);
    expect(opaqueOf({ command: "python run.py", body: "y".repeat(5_000) })[0]).toMatch(/payload/);
    expect(opaqueOf({ command: "ls" })).toEqual([]);
  });

  it("an argv-style array under a command key reads as one command line", () => {
    expect(destructiveOf("bash", { command: ["rm", "-rf", "/tmp/x"] })).toMatch(/rm deletes files/);
    expect(destructiveOf("bash", { command: ["git", "status"] })).toBeUndefined();
  });

  it("sends a split note without calling Jev, then the same call reaches the card", async () => {
    const r = rig({ mode: "jev", probability: 0.99 });
    const complex = call("run_script", { command: "a && b && c && d" }, "k1");
    expect(await r.outcome(complex)).toBe(false);
    expect(r.approvals.noteFor("conv", "k1")).toMatch(new RegExp(`^${SPLIT_PREFIX}`));
    expect(r.asked).toEqual([]);
    expect(await r.outcome({ ...complex, callId: "k2" })).toBe(false);
    // Sent back twice already: the third identical call goes to the owner.
    expect(await r.outcome({ ...complex, callId: "k3" })).toBe("card");
    expect(r.audit.map((e) => e.error?.startsWith(SPLIT_PREFIX))).toEqual([true, true]);
  });

  it("Jev itself can say too complex", async () => {
    const r = rig({ mode: "jev", probability: 0.99, complexity: 0.9 });
    expect(await r.outcome(call("send_note", { text: "hi" }))).toBe(false);
    expect(r.approvals.noteFor("conv", "c-send_note")).toMatch(new RegExp(`^${SPLIT_PREFIX}`));
  });
});

const input = (text: string, id = 1): TranscriptEntry => ({ id, kind: "input", at: 0, text });
const tool = (id: number, name: string, args: unknown, output: string): TranscriptEntry => ({
  id,
  kind: "tool",
  at: 0,
  step: { callId: `t${id}`, name, status: "done", input: args, output, durationMs: 1 },
});

describe("B: context", () => {
  it("carries the latest request, the last 5 calls and the bot; redacts secrets", () => {
    const transcript = [
      input("old request", 1),
      ...Array.from({ length: 8 }, (_, i) => tool(10 + i, `t${i}`, { q: i }, `r${i}`)),
      tool(
        30,
        "vault_list",
        { apiKey: "sk-live-abcdefghijklmnop" },
        "item: sk-live-abcdefghijklmnop",
      ),
      input("please tidy my notes, token=hunter2", 40),
    ];
    const ctx = buildContext({ name: "Nova", description: "notes bot" }, transcript, {
      ...call("note_write", { password: "p4ss", body: "Bearer abc.def" }),
      description: "Writes one note file in the bot's own workspace.",
    });
    expect(ctx.bot).toBe("Nova — notes bot");
    expect(ctx.request).toContain("please tidy my notes");
    expect(ctx.call.description).toContain("own workspace");
    expect(ctx.hints).toEqual([]);
    expect(ctx.recent).toHaveLength(5);
    expect(ctx.recent.at(-1)?.name).toBe("vault_list");
    expect(ctx.recent.at(-1)?.result).toBeNull();
    const text = JSON.stringify(ctx);
    for (const secret of ["sk-live-abcdefghijklmnop", "hunter2", "p4ss", "abc.def"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("stays under the size cap", () => {
    const big = "y".repeat(5_000);
    const transcript = Array.from({ length: 10 }, (_, i) => tool(i, `t${i}`, { a: big }, big));
    const ctx = buildContext(
      undefined,
      [...transcript, input(big, 99)],
      call("x", { a: big, b: big }),
    );
    expect(JSON.stringify(ctx).length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
  });
});

describe("C: destructive without justification", () => {
  it("detects destructive calls", () => {
    expect(destructiveOf("artifact_delete", {})).toBeDefined();
    expect(destructiveOf("run", { command: "git reset --hard HEAD" })).toBeDefined();
    expect(destructiveOf("run", { command: "git push --force origin main" })).toBeDefined();
    expect(destructiveOf("run", { sql: "DELETE FROM users" })).toBeDefined();
    expect(destructiveOf("run", { sql: "DELETE FROM users WHERE id = 1" })).toBeUndefined();
    expect(destructiveOf("run", { command: "echo hi > notes.md" })).toBeDefined();
    expect(destructiveOf("run", { command: "ls 2>/dev/null" })).toBeUndefined();
    expect(destructiveOf("write", { path: "a", overwrite: true })).toBeDefined();
    expect(destructiveOf("artifact_list", {})).toBeUndefined();
  });

  it("destructive with no asking context is denied with the destructive note, no Jev", async () => {
    const r = rig({ mode: "jev", probability: 0.99 });
    expect(await r.outcome(call("artifact_delete", { id: "a" }))).toBe(false);
    expect(r.approvals.noteFor("conv", "c-artifact_delete")).toMatch(
      new RegExp(`^${DESTRUCTIVE_PREFIX}`),
    );
    expect(r.asked).toEqual([]);
  });
});

describe("C: destructive asked for by the owner", () => {
  const adjudicator = (probability: number, asked: string[]) =>
    makeAdjudicator({
      decide: {
        available: true,
        yesNo: (state, rubric) => {
          asked.push(String(state));
          return Effect.succeed(rubric === JEV_COMPLEX_RUBRIC ? 0 : probability);
        },
      },
      record: () => {},
      profileOf: () =>
        ({
          id: "p1",
          name: "Nova",
          description: "",
          policies: { approvalMode: "jev", autoApprove: [] },
        }) as never,
      transcript: () => Effect.succeed([input("please delete the old draft artifact")]),
    });

  it("is not auto-denied: Jev is consulted; below the destructive bar it goes to the card", async () => {
    for (const probability of [0.85, 0.05]) {
      const asked: string[] = [];
      const verdict = await Effect.runPromise(
        adjudicator(probability, asked)("conv", call("artifact_delete", { id: "a" })),
      );
      expect(verdict).toBeUndefined(); // undefined = the owner's card
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]).toContain("please delete the old draft artifact");
    }
  });

  it("only a very sure Jev runs it", async () => {
    const verdict = await Effect.runPromise(
      adjudicator(0.95, [])("conv", call("artifact_delete", { id: "a" })),
    );
    expect(verdict).toEqual({ approved: true });
  });
});

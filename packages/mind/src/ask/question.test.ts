/**
 * ask_user_question against the real engine (faux model, sqlite file, a
 * restart simulated by reopening the same file): the card must not vanish.
 * Before the fix the restarted call read "interrupted" and no card came back,
 * so the owner had nothing to answer. Also: a message the owner sends instead
 * of tapping releases the card (declined, with a note) so the turn goes on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { makeApprovals, type ApprovalsService } from "../approvals.ts";
import { converseService } from "../converse/converse.ts";
import { projectTranscript } from "../converse/steps.ts";
import { ASK_USER_QUESTION, OWNER_REPLIED, questionTools, releaseQuestions } from "./question.ts";
import { readView, TRANSCRIPT_WINDOW } from "../converse/view.ts";

const ctx = BACKGROUND_CONTEXT;

const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

const ASK = {
  question: "Which report format?",
  options: [{ label: "PDF" }, { label: "Sheet" }],
};

const toolsFor = (approvals: ApprovalsService) =>
  questionTools({
    approvals,
    profiles: { scopeOf: () => ({ owner: "owner-a", profile: "p1" }), profileOf: () => undefined },
    audit: { record: () => {}, tail: () => [] },
  } as never);

describe("ask_user_question across a restart (faux model)", () => {
  it("the card comes back after the restart and the answer finishes the turn", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(ASK_USER_QUESTION, ASK), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxText("going with the sheet")),
    ]);
    const model = faux.getModel();
    const dir = mkdtempSync(join(tmpdir(), "spriessen-ask-restart-"));
    const path = join(dir, "harness.db");
    const open = async (approvals: ApprovalsService) => {
      const registry = createRegistry();
      registry.install({ name: "ask", tools: [...toolsFor(approvals)] });
      return Harness.open(await openNodeSqliteStorage(path), { models, registry }, ctx);
    };
    const agent = { model: { provider: model.provider, modelId: model.id } };

    // First process: the question parks, then the process dies.
    const firstApprovals = makeApprovals();
    const first = await open(firstApprovals);
    const before = converseService(first, agent);
    const chat = await Effect.runPromise(before.ensure("ask-restart"));
    const id = String(chat.id);
    await Effect.runPromise(before.submit(chat, "pick a format"));
    await until(() => firstApprovals.pendingFor(id).length > 0);
    expect(firstApprovals.pendingFor(id)).toHaveLength(1);

    // Second process: a fresh broker (pending cards are in memory only).
    const approvals = makeApprovals();
    const second = await open(approvals);
    const after = converseService(second, agent);
    after.resume();
    await until(() => approvals.pendingFor(id).length > 0);
    const [card] = approvals.pendingFor(id);
    expect(card).toMatchObject({ name: ASK_USER_QUESTION, input: { question: ASK.question } });

    approvals.decide(id, card!.callId, true, undefined, { answer: "Sheet" });
    const reopened = await Effect.runPromise(after.open(id));
    const steps = async () =>
      projectTranscript(
        (await readView(reopened!, TRANSCRIPT_WINDOW))?.entries ?? [],
        undefined,
        false,
      );
    await until(async () => (await steps()).some((s) => s.kind === "output"));
    const text = JSON.stringify(await steps());
    expect(text).toContain("The owner chose option 2: Sheet");
    expect(text).toContain("going with the sheet");
    expect(text).not.toContain("interrupted");
    await second.close(ctx);
    // The "dead" first process still holds its in-memory card; let it go so
    // its harness can close.
    for (const p of firstApprovals.pendingFor(id)) firstApprovals.decide(id, p.callId, false);
    await first.close(ctx).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("releaseQuestions", () => {
  it("declines only the questions waiting in that conversation, with the owner-replied note", async () => {
    const approvals = makeApprovals();
    const [tool] = toolsFor(approvals);
    const run = (conversationId: string, callId: string) =>
      tool!.execute(ASK as never, { conversationId, callId } as never, {} as never) as Promise<{
        isError?: boolean;
        output: { text: string }[];
      }>;
    const mine = run("c1", "q1");
    const other = run("c2", "q2");
    const gate = Effect.runPromise(
      approvals.request("c1", "g1", { callId: "g1", name: "file_delete", input: {} }),
    );
    await until(
      () => approvals.pendingFor("c1").length === 2 && approvals.pendingFor("c2").length === 1,
    );

    expect(releaseQuestions(approvals, "c1")).toBe(1);
    const result = await mine;
    expect(result.isError).toBe(true);
    expect(result.output[0]?.text).toBe(OWNER_REPLIED);
    // The other chat's question and this chat's approval card still wait.
    expect(approvals.pendingFor("c2").map((p) => p.callId)).toEqual(["q2"]);
    expect(approvals.pendingFor("c1").map((p) => p.callId)).toEqual(["g1"]);
    approvals.decide("c2", "q2", false);
    approvals.decide("c1", "g1", false);
    await other;
    expect(await gate).toBe(false);
  });
});

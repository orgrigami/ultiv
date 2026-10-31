/**
 * ask_user_question over the real REST handler and an offline mind: the
 * card waits in Needs you, the owner's answer continues the call, dismissing
 * tells the bot to carry on, YOLO still asks, and another owner can neither
 * see nor answer it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind, questionTools } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";

const scratch = mkdtempSync(join(tmpdir(), "spreissen-ask-"));
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let bot = "";
let conversation = "";
let calls = 0;

const call = async (method: string, path: string, body?: unknown, user = "owner-a") => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-spreissen-user": user },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as any };
};

const ask = (args: object) => {
  const tool = questionTools({
    profiles: handle.mind.profiles,
    approvals: handle.mind.approvals,
    audit: handle.mind.audit,
  })[0];
  if (tool === undefined) throw new Error("missing ask_user_question");
  const callId = `q${++calls}`;
  const result = tool.execute(
    args as never,
    { conversationId: conversation, callId } as never,
    {} as never,
  ) as Promise<{ isError?: boolean; output: { text: string }[] }>;
  return {
    callId,
    result: result.then((r) => ({ error: r.isError === true, text: r.output[0]?.text ?? "" })),
  };
};

const waiting = async (callId: string) => {
  for (let i = 0; i < 100; i++) {
    if (handle.mind.approvals.pendingFor(conversation).some((p) => p.callId === callId)) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the question never parked");
};

const question = {
  question: "Which report format?",
  options: [{ label: "PDF" }, { label: "Spreadsheet", detail: "Easier to sort" }],
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage() });
  bot = (await handle.mind.profiles.create("owner-a", { name: "Asker", onboard: false })).id;
  const main = await handle.mind.profiles.ensureMain("owner-a", bot);
  conversation = String(
    await Effect.runPromise(
      handle.mind.converse.conversationIdOf(await handle.mind.profiles.keyOfRow(main)),
    ),
  );
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("ask_user_question", () => {
  it("shows in Needs you and the tapped option continues the call", async () => {
    const { callId, result } = ask(question);
    await waiting(callId);
    const inbox = await call("GET", "/api/approvals");
    const row = inbox.json.find((entry: { callId: string }) => entry.callId === callId);
    expect(row).toMatchObject({
      name: "ask_user_question",
      input: { question: "Which report format?", allowOther: true },
    });
    expect(row.input.options[1]).toEqual({ label: "Spreadsheet", detail: "Easier to sort" });
    const answered = await call("POST", `/api/approvals/${conversation}/${callId}`, {
      approved: true,
      input: { answer: "Spreadsheet" },
    });
    expect(answered.status).toBe(200);
    expect(await result).toEqual({ error: false, text: "The owner chose option 2: Spreadsheet" });
  });

  it("takes the owner's own words, unless other answers are off", async () => {
    const own = ask(question);
    await waiting(own.callId);
    await call("POST", `/api/approvals/${conversation}/${own.callId}`, {
      approved: true,
      input: { answer: "  Both, please " },
    });
    expect((await own.result).text).toBe("The owner answered in their own words: Both, please");
    const strict = ask({ ...question, allow_other: false });
    await waiting(strict.callId);
    await call("POST", `/api/approvals/${conversation}/${strict.callId}`, {
      approved: true,
      input: { answer: "Neither" },
    });
    expect(await strict.result).toMatchObject({ error: true });
  });

  it("dismissing tells the bot to carry on", async () => {
    const { callId, result } = ask(question);
    await waiting(callId);
    await call("POST", `/api/approvals/${conversation}/${callId}`, { approved: false });
    const outcome = await result;
    expect(outcome.error).toBe(true);
    expect(outcome.text).toContain("carry on with your best judgement");
  });

  it("YOLO still asks the owner", async () => {
    const row = await handle.mind.profiles.get("owner-a", bot);
    if (row === undefined) throw new Error("missing bot");
    await handle.mind.profiles.update("owner-a", bot, {
      policies: { ...row.policies, approvalMode: "yolo" },
    });
    const { callId, result } = ask(question);
    await waiting(callId);
    await call("POST", `/api/approvals/${conversation}/${callId}`, {
      approved: true,
      input: { answer: "PDF" },
    });
    expect((await result).text).toBe("The owner chose option 1: PDF");
  });

  it("the wrong person can't see or answer it", async () => {
    const { callId, result } = ask(question);
    await waiting(callId);
    const theirs = await call("GET", "/api/approvals", undefined, "owner-b");
    expect(theirs.json.some((entry: { callId: string }) => entry.callId === callId)).toBe(false);
    const forged = await call(
      "POST",
      `/api/approvals/${conversation}/${callId}`,
      { approved: true, input: { answer: "PDF" } },
      "owner-b",
    );
    expect(forged.status).toBe(403);
    expect(handle.mind.approvals.pendingFor(conversation).some((p) => p.callId === callId)).toBe(
      true,
    );
    await call("POST", `/api/approvals/${conversation}/${callId}`, { approved: false });
    await result;
  });
});

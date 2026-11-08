/**
 * Redirect now against the real engine (faux model, MemoryStorage): the
 * pure step logic, a streamed reply cut and kept as interrupted, a running
 * tool allowed to finish first, a waiting approval denied, and queued
 * messages kept (unlike Stop).
 */
import { describe, expect, it } from "vite-plus/test";
import { bool, obj, opt } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineTool,
  Harness,
  MemoryStorage,
  type InboxState,
  type LiveState,
} from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { makeApprovals, type ApprovalsService } from "../approvals.ts";
import { converseService } from "./converse.ts";
import { redirectStep, redirectTurn } from "./redirect.ts";
import { projectTranscript } from "./steps.ts";
import { isStopped } from "./stop.ts";
import { readView, TRANSCRIPT_WINDOW } from "./view.ts";

const ctx = BACKGROUND_CONTEXT;

const lastUser = (context: unknown): string => {
  const users = (context as { messages: { role: string; content: unknown }[] }).messages.filter(
    (m) => m.role === "user",
  );
  const content = users.at(-1)?.content;
  return typeof content === "string"
    ? content
    : ((content as { text?: string }[] | undefined) ?? []).map((b) => b.text ?? "").join("");
};

type Rig = Awaited<ReturnType<typeof rig>>;

const rig = async (first: "stream" | "tool", approvals: ApprovalsService = makeApprovals()) => {
  const faux = fauxProvider({ tokensPerSecond: first === "stream" ? 20 : 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const toolStarted = new Promise<void>((resolve) => (started = resolve));
  let chatId = "";
  const registry = createRegistry();
  registry.install({
    name: "probe",
    tools: [
      defineTool({
        name: "wait",
        description: "Waits until released, or asks approval with gated: true.",
        parameters: obj({ gated: opt(bool()) }, { open: true }),
        execute: async (args) => {
          started();
          if (args.gated === true) {
            const request = { callId: "c1", name: "wait", input: {} };
            const ok = await Effect.runPromise(approvals.request(chatId, "c1", request));
            return { output: [{ type: "text", text: ok ? "approved" : "denied" }] };
          }
          await gate;
          return { output: [{ type: "text", text: "waited" }] };
        },
      }),
    ],
  });
  const seen: string[] = [];
  const step =
    (message: ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
    (context) => {
      seen.push(lastUser(context));
      return message;
    };
  const long = "word ".repeat(400);
  faux.setResponses([
    first === "stream"
      ? step(fauxAssistantMessage(fauxText(long)))
      : step(fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" })),
    step(fauxAssistantMessage(fauxText("after tool"))),
    step(fauxAssistantMessage(fauxText("redirected answer"))),
    step(fauxAssistantMessage(fauxText("spare"))),
  ]);
  const model = faux.getModel();
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
  const converse = converseService(harness, {
    model: { provider: model.provider, modelId: model.id },
  });
  const chat = await Effect.runPromise(converse.ensure("redirect-test"));
  chatId = String(chat.id);
  const view = async () => await readView(chat, TRANSCRIPT_WINDOW);
  return { harness, converse, chat, approvals, release, toolStarted, seen, view };
};

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

const redirect = (r: Rig, text: string, graceMs = 2_000) =>
  redirectTurn({ converse: r.converse, approvals: r.approvals, graceMs, pollMs: 10 }, r.chat, text);

describe("redirectStep", () => {
  const busy = (tools: LiveState["tools"] = undefined): LiveState =>
    ({ run: { taskId: 1, inputs: [] }, ...(tools ? { tools } : {}) }) as unknown as LiveState;
  it("submits when idle, denies approvals first, drains running tools within grace", () => {
    expect(redirectStep(undefined, 0, true)).toBe("submit");
    expect(redirectStep({} as LiveState, 0, true)).toBe("submit");
    expect(redirectStep(busy(), 1, true)).toBe("deny");
    expect(redirectStep(busy(), 0, true)).toBe("abort");
    const running = busy([{ callId: "a", name: "x", status: "running" }]);
    expect(redirectStep(running, 0, true)).toBe("drain");
    expect(redirectStep(running, 0, false)).toBe("abort");
    expect(redirectStep(busy([{ callId: "a", name: "x", status: "done" }]), 0, true)).toBe("abort");
  });
});

describe("Redirect now (faux model)", () => {
  it("cuts a streaming reply, keeps it as interrupted, and answers the new message", async () => {
    const r = await rig("stream");
    const first = await Effect.runPromise(r.converse.submit(r.chat, "write an essay"));
    // Wait until some of the reply has streamed (and been committed as a partial).
    const streamed = async () => {
      const live = (await r.view())?.docs["pi.live"] as LiveState | undefined;
      return JSON.stringify(live?.generation?.message?.content ?? []).includes("word");
    };
    await until(streamed);
    const { submission, interrupted } = await redirect(r, "stop, do this instead");
    expect(interrupted).toBe(true);
    const failure = await Effect.runPromise(r.converse.settle(r.chat, first)).then(
      () => "ok",
      (e) => e,
    );
    expect(isStopped(failure)).toBe(true);
    const answer = await Effect.runPromise(r.converse.settle(r.chat, submission));
    expect(answer.text).toBe("after tool"); // the next scripted reply
    const steps = projectTranscript((await r.view())?.entries ?? [], undefined, false);
    console.log(
      JSON.stringify(
        (await r.view())?.entries.map((e) => [e.kind, JSON.stringify(e.model).slice(0, 300)]),
      ),
    );
    const cut = steps.find((s) => s.kind === "output" && s.interrupted === true);
    expect(cut).toBeDefined();
    expect(steps.at(-1)).toMatchObject({ kind: "output", text: "after tool" });
    expect(r.seen.at(-1)).toBe("stop, do this instead");
    await r.harness.close(ctx);
  });

  it("lets a running tool finish before cutting the turn", async () => {
    const r = await rig("tool");
    const first = await Effect.runPromise(r.converse.submit(r.chat, "use the tool"));
    await r.toolStarted;
    setTimeout(() => r.release(), 100);
    const { submission } = await redirect(r, "new plan");
    await Effect.runPromise(r.converse.settle(r.chat, first)).catch(() => undefined);
    await Effect.runPromise(r.converse.settle(r.chat, submission));
    const steps = projectTranscript((await r.view())?.entries ?? [], undefined, false);
    const tool = steps.find((s) => s.kind === "tool");
    // The tool's own result, not an `aborted` one.
    expect(tool).toMatchObject({ step: { status: "done", output: "waited" } });
    expect(r.seen.at(-1)).toBe("new plan");
    await r.harness.close(ctx);
  });

  it("denies a waiting approval and keeps queued messages", async () => {
    const approvals = makeApprovals();
    const r = await rig("tool", approvals);
    r.release();
    const faux = await Effect.runPromise(r.converse.submit(r.chat, "first"));
    await r.toolStarted;
    const later = await Effect.runPromise(r.converse.submit(r.chat, "later", "followUp"));
    const inbox = async () =>
      ((await r.view())?.docs["pi.inbox"] as InboxState | undefined)?.items ?? [];
    expect((await inbox()).length).toBe(1);
    const { submission } = await redirect(r, "redirect");
    await Effect.runPromise(r.converse.settle(r.chat, faux)).catch(() => undefined);
    await Effect.runPromise(r.converse.settle(r.chat, submission));
    // The follow-up was not withdrawn: it is answered too.
    await Effect.runPromise(r.converse.settle(r.chat, later));
    expect(r.seen).toContain("redirect");
    expect(approvals.pendingFor(String(r.chat.id))).toEqual([]);
    await r.harness.close(ctx);
  });
});

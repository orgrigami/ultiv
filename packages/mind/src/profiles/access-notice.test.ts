/**
 * Access-change notices: the words say what changed (tools removed/added,
 * the approval mode), nothing is said when nothing bearing on work changed,
 * and on the real engine (faux model) only a conversation with a turn in
 * flight gets the note; an idle chat gets nothing.
 */
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import type { ProfileInfo } from "@spriessen/contracts";
import { converseService } from "../converse/converse.ts";
import { accessChangeText, noticeRunningWork, type AgentTools } from "./access-notice.ts";

const ctx = BACKGROUND_CONTEXT;

const bot = (over: { mode?: "manual" | "jev" | "yolo"; tools?: string[] | null }) =>
  ({
    id: "bot-1",
    owner: "owner",
    toolAllowlist: over.tools ?? null,
    policies: { approvalMode: over.mode ?? "manual" },
  }) as unknown as ProfileInfo;

const toolsOf = (profile: ProfileInfo): AgentTools =>
  profile.toolAllowlist === null ? { remove: [] } : profile.toolAllowlist.map((name) => ({ name }));

describe("accessChangeText", () => {
  it("names the tools removed and added, and the new approval mode", () => {
    const text = accessChangeText(
      bot({ tools: ["bash", "web_search"], mode: "yolo" }),
      bot({ tools: ["web_search", "http_request"], mode: "manual" }),
      toolsOf,
    );
    expect(text).toContain("[access changed]");
    expect(text).toContain("removed: bash");
    expect(text).toContain("added: http_request");
    expect(text).toContain("approval mode is now Manual");
  });

  it("from every tool to a list, and back", () => {
    expect(accessChangeText(bot({}), bot({ tools: ["web_search"] }), toolsOf)).toContain(
      "limited to: web_search",
    );
    expect(accessChangeText(bot({ tools: ["web_search"] }), bot({}), toolsOf)).toContain(
      "every tool is allowed now",
    );
  });

  it("says nothing when nothing bearing on work changed", () => {
    expect(accessChangeText(bot({ tools: ["a"] }), bot({ tools: ["a"] }), toolsOf)).toBeNull();
  });
});

describe("noticeRunningWork (faux model)", () => {
  it("leaves the note only with work in flight", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started!: () => void;
    const busy = new Promise<void>((resolve) => (started = resolve));
    const hold: FauxResponseStep = async () => {
      started();
      await gate;
      return fauxAssistantMessage(fauxText("done"));
    };
    faux.setResponses([hold, fauxAssistantMessage(fauxText("after"))]);
    const model = faux.getModel();
    const harness = await Harness.open(
      new MemoryStorage(),
      { models, registry: createRegistry() },
      ctx,
    );
    const converse = converseService(harness, {
      model: { provider: model.provider, modelId: model.id },
    });
    const running = await Effect.runPromise(converse.ensure("running"));
    await Effect.runPromise(converse.ensure("idle"));
    const turn = Effect.runPromise(converse.turn(running, "long work"));
    await busy;
    const heard = await noticeRunningWork(
      {
        converse,
        profiles: {
          listSessions: async () =>
            [
              { id: "a", profile: "bot-1" },
              { id: "b", profile: "bot-1" },
            ] as never,
          keyOfRow: async (row) => (row.id === "a" ? "running" : "idle"),
        },
        tasks: { list: () => Effect.succeed([]) },
      },
      bot({}),
      "[access changed] Your owner changed what you may do: tools removed: bash.",
    );
    expect(heard).toBe(1);
    release();
    await turn;
    const idle = await Effect.runPromise(converse.ensure("idle"));
    const textOf = async (c: typeof running) =>
      JSON.stringify((await c.viewState(ctx)).value ?? {});
    expect(await textOf(running)).toContain("[access changed]");
    expect(await textOf(idle)).not.toContain("[access changed]");
    await harness.close(ctx);
  });
});

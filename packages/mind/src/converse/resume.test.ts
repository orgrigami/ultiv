/**
 * Slice 8, a turn cut by a restart (faux model, sqlite file, crash simulated
 * by opening the same file again without closing the first process): opening
 * the harness alone never runs it, so it would sit idle silently;
 * `converse.resume()` (called at boot by the entity) finishes the turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, type LiveState } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { converseService } from "./converse.ts";
import { projectTranscript } from "./steps.ts";

const ctx = BACKGROUND_CONTEXT;

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

/** Never streams; ends only when the harness signals it (close or abort). */
const silent: FauxResponseStep = (_context, options) =>
  new Promise((resolve) => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("cut")));
  });

describe("a turn cut by a restart (faux model)", () => {
  it("does not run by itself after the reopen, and resume() finishes it", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([silent, fauxAssistantMessage(fauxText("picked up after the restart"))]);
    const model = faux.getModel();
    const dir = mkdtempSync(join(tmpdir(), "spreissen-resume-"));
    const path = join(dir, "harness.db");
    const open = async () =>
      Harness.open(await openNodeSqliteStorage(path), { models, registry: createRegistry() }, ctx);
    const agent = { model: { provider: model.provider, modelId: model.id } };

    // First process: the turn is mid-request when the process dies.
    const first = await open();
    const before = converseService(first, agent);
    const chat = await Effect.runPromise(before.ensure("resume-test"));
    await Effect.runPromise(before.submit(chat, "hello"));
    await until(async () => (await Effect.runPromise(before.liveOf(chat)))?.run !== undefined);
    const second = await open();

    // Second process, before resume: the turn is still there and nothing runs it.
    const after = converseService(second, agent);
    const reopened = await Effect.runPromise(after.open(String(chat.id)));
    const view = async () => (await reopened!.viewState(ctx)).value;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(faux.state.callCount).toBe(1);
    expect(((await view())?.docs["pi.live"] as LiveState | undefined)?.run).toBeDefined();

    after.resume();
    await until(async () => {
      const steps = projectTranscript((await view())?.entries ?? [], undefined, false);
      return steps.some((s) => s.kind === "output" && s.text === "picked up after the restart");
    });
    const steps = projectTranscript((await view())?.entries ?? [], undefined, false);
    expect(steps.at(-1)).toMatchObject({ kind: "output", text: "picked up after the restart" });
    expect(faux.state.callCount).toBe(2);
    expect(((await view())?.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();
    await second.close(ctx);
    await first.close(ctx).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

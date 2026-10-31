/**
 * Parked tasks (slice 6) against the real engine: a turn cut off by a
 * restart more times than `settings.restartLimit` allows is parked, listed
 * by `parked()`, and runs again (and answers) after `retryParked()`.
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

describe("parked tasks (faux model)", () => {
  it("lists a turn parked by the restart limit and runs it again on retry", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([silent, fauxAssistantMessage(fauxText("back again"))]);
    const model = faux.getModel();
    // A file, as in production: closing the harness closes its storage.
    const dir = mkdtempSync(join(tmpdir(), "spreissen-parked-"));
    const path = join(dir, "harness.db");
    const open = async () =>
      Harness.open(
        await openNodeSqliteStorage(path),
        { models, registry: createRegistry(), settings: { restartLimit: 1 } },
        ctx,
      );
    const agent = { model: { provider: model.provider, modelId: model.id } };

    // First process: the turn starts, then the process goes away mid-request.
    const first = await open();
    const before = converseService(first, agent);
    const chat = await Effect.runPromise(before.ensure("parked-test"));
    await Effect.runPromise(before.submit(chat, "hello"));
    await until(async () => (await Effect.runPromise(before.liveOf(chat)))?.run !== undefined);
    // A crash, not a clean close: the task is still "running" in storage when the next process opens.
    const second = await open();

    // Second process: one cut-off is the limit here, so the turn is parked, not rerun.
    const after = converseService(second, agent);
    const parked = await Effect.runPromise(after.parked());
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ conversationId: String(chat.id) });
    expect(parked[0]?.kind).toBe("pi.generation");
    expect(await Effect.runPromise(after.retryParked("999999"))).toBe("not_parked");

    expect(await Effect.runPromise(after.retryParked(parked[0]!.taskId))).toBe("retried");
    const reopened = await Effect.runPromise(after.open(String(chat.id)));
    const view = async () => (await reopened!.viewState(ctx)).value;
    await until(async () => {
      const steps = projectTranscript((await view())?.entries ?? [], undefined, false);
      return steps.some((s) => s.kind === "output" && s.text === "back again");
    });
    const steps = projectTranscript((await view())?.entries ?? [], undefined, false);
    expect(steps.at(-1)).toMatchObject({ kind: "output", text: "back again" });
    expect(await Effect.runPromise(after.parked())).toEqual([]);
    expect(((await view())?.docs["pi.live"] as LiveState | undefined)?.run).toBeUndefined();
    await second.close(ctx);
    await first.close(ctx).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

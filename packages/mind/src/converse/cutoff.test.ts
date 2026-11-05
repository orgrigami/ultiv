/**
 * A turn a crash cuts off, against the real engine (pi-durable 1.5): it is
 * not re-sent and not parked. The run ends with `pi.live.runFailure`, the
 * chat shows why as a note, and the owner's next message answers normally.
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
  type FauxResponseStep,
} from "@earendil-works/pi-ai";
import { converseService } from "./converse.ts";
import { projectTranscript } from "./steps.ts";
import { readView } from "./view.ts";

const ctx = BACKGROUND_CONTEXT;

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 300 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

/** Never streams; ends only when the harness signals it (close or abort). */
const silent: FauxResponseStep = (_context, options) =>
  new Promise((resolve) => {
    options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("cut")));
  });

describe("a turn cut off by a crash (faux model)", () => {
  it("ends visibly instead of re-sending, and the next message answers", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([silent, fauxAssistantMessage(fauxText("back again"))]);
    const model = faux.getModel();
    // A file, as in production: closing the harness closes its storage.
    const dir = mkdtempSync(join(tmpdir(), "spriessen-cutoff-"));
    const path = join(dir, "harness.db");
    const open = async () =>
      Harness.open(
        await openNodeSqliteStorage(path),
        {
          models,
          registry: createRegistry(),
          settings: { restartLimit: 1, retry: { maxRetries: 0 } },
        },
        ctx,
      );
    const agent = { model: { provider: model.provider, modelId: model.id } };

    // First process: the turn starts, then the process goes away mid-request.
    const first = await open();
    const before = converseService(first, agent);
    const chat = await Effect.runPromise(before.ensure("cutoff-test"));
    await Effect.runPromise(before.submit(chat, "hello"));
    await until(async () => (await Effect.runPromise(before.liveOf(chat)))?.run !== undefined);
    // A crash, not a clean close: the task is still "running" in storage when the next process opens.
    const second = await open();
    const after = converseService(second, agent);
    after.resume();
    const reopened = (await Effect.runPromise(after.open(String(chat.id))))!;
    await until(async () => (await readView(reopened)).docs["pi.live"]?.["run"] === undefined);
    const ended = await readView(reopened);
    const live = ended.docs["pi.live"] as { runFailure?: { reason: string } } | undefined;
    expect(["interrupted", "restart_limit"]).toContain(live?.runFailure?.reason);
    const note = projectTranscript(ended.entries, ended.docs["pi.live"] as never, false).at(-1);
    expect(note).toMatchObject({ kind: "note" });
    expect(String((note as { text?: string }).text)).toContain("Send your message again");

    await Effect.runPromise(after.submit(reopened, "again"));
    await until(async () => {
      const view = await readView(reopened);
      return projectTranscript(view.entries, undefined, false).some(
        (s) => s.kind === "output" && s.text === "back again",
      );
    });
    const steps = projectTranscript((await readView(reopened)).entries, undefined, false);
    expect(steps.at(-1)).toMatchObject({ kind: "output", text: "back again" });
    await second.close(ctx);
    await first.close(ctx).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
});

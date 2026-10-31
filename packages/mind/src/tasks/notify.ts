/**
 * notify_owner: a running task posts a short progress line into its parent
 * chat as a passive entry — the owner sees it live, the parent bot's model is
 * not woken. At most one per task every two minutes, ≤280 characters.
 */
import { Effect } from "effect";
import type { External } from "@spreissen/core";
import type { ConverseService } from "../converse/converse.ts";
import { findTask, updateTask } from "./store.ts";

/** The passive entry kind a task update is stored under in the parent chat. */
export const TASK_UPDATE_KIND = "ultiv.task-update";
export const NOTIFY_INTERVAL_MS = 120_000;
export const NOTIFY_CHARS = 280;
/** Updates kept on the row (the transcript keeps all of them). */
const KEPT_UPDATES = 20;

export type NotifyOutcome =
  | { readonly status: "posted"; readonly text: string }
  | { readonly status: "too_soon"; readonly waitMs: number }
  | { readonly status: "not_running" };

const clipUpdate = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > NOTIFY_CHARS ? `${flat.slice(0, NOTIFY_CHARS - 1).trimEnd()}…` : flat;
};

export const notifyOwner = (
  converse: ConverseService,
  id: string,
  raw: string,
  now = Date.now(),
): Effect.Effect<NotifyOutcome, External> =>
  Effect.gen(function* () {
    const task = yield* findTask(converse, id);
    if (task === undefined || task.status !== "running") return { status: "not_running" } as const;
    const last = task.updates?.at(-1);
    if (last !== undefined && now - last.at < NOTIFY_INTERVAL_MS) {
      return { status: "too_soon", waitMs: NOTIFY_INTERVAL_MS - (now - last.at) } as const;
    }
    const text = clipUpdate(raw);
    yield* updateTask(converse, id, (row) => ({
      ...row,
      updates: [...(row.updates ?? []), { at: now, text }].slice(-KEPT_UPDATES),
    }));
    if (task.conversationId !== null) {
      const parent = yield* converse.open(task.conversationId);
      if (parent !== undefined) {
        yield* converse.write(parent, TASK_UPDATE_KIND, { taskId: id, text, at: now });
      }
    }
    return { status: "posted", text } as const;
  });

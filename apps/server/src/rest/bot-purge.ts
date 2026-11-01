/**
 * The purge cascade: every store a bot touches (registry row and sessions,
 * mailbox, memory, vault, schedules, webhooks, watches, rooms and its
 * artifact tree). The DELETE route and the main bot's bot_delete share it.
 *
 * The bot's microVM is NOT destroyed here (phase 4, one VM per home): the
 * VM belongs to the bot's home — the org or its department — and is shared
 * with the home's other bots. A department's VM goes with the department
 * (`orgService.removeDepartment` tears it down); the org VM only with the
 * org.
 */
import { rmSync } from "node:fs";
import { resolveInside, artifactsDir } from "@spriessen/ext";
import { removeSensorsForSessions } from "@spriessen/mind";
import { removeCronJobsForSessions } from "../cron.ts";
import { removeWebhooksForSessions } from "../webhooks.ts";
import type { RouteArgs } from "./types.ts";

/** The purge cascade: every store a profile touches. */
export async function purgeBot(
  mind: RouteArgs["mind"],
  owner: string,
  id: string,
): Promise<unknown> {
  const sessions = await mind.profiles.remove(owner, id);
  const sessionIds = sessions.map((row) => row.id);
  const [mailbox, memory, vault, cron, webhooks, sensors, rooms] = await Promise.all([
    mind.mailbox.purgeProfile(owner, id),
    mind.memory.removeProfile(owner, id),
    Promise.resolve(mind.vault?.removeProfile(owner, id) ?? 0),
    removeCronJobsForSessions(mind.converse, sessionIds),
    removeWebhooksForSessions(mind, sessionIds),
    removeSensorsForSessions(mind.converse, sessionIds),
    mind.rooms.purgeProfile(owner, id),
  ]);
  let artifacts = 0;
  try {
    const dir = resolveInside(artifactsDir(), owner, id);
    rmSync(dir, { recursive: true, force: true });
    artifacts = sessions.length;
  } catch {
    artifacts = -1;
  }
  // The VM survives the bot (one VM per home, shared with the home's other
  // bots); the field stays so the answer's shape is stable.
  const sandbox = false;
  return {
    ok: true,
    sessions: sessionIds.length,
    mailbox,
    memory,
    vault,
    cron,
    webhooks,
    sensors,
    rooms,
    artifacts,
    sandbox,
    note:
      "transcripts stay in harness storage (retention); registry rows and files are gone; " +
      "the home's shared VM is not touched",
  };
}

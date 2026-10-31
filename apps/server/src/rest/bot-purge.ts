/**
 * The purge cascade: every store a bot touches (registry row and sessions,
 * mailbox, memory, vault, schedules, webhooks, watches, rooms, artifacts and
 * its microVM). The DELETE route and the main bot's bot_delete share it.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { artifactsDir, destroySandbox, resolveInside, sandboxNameOf } from "@spriessen/ext";
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
  // The bash tool's microVM goes with the bot: same name derivation, best
  // effort (a missing VM or a stuck runtime never fails the purge).
  const sandbox = await Promise.race([
    destroySandbox(sandboxNameOf(join(artifactsDir(), owner, id)))
      .then(() => true)
      .catch(() => false),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 8_000)),
  ]);
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
    note: "transcripts stay in harness storage (retention); registry rows and files are gone",
  };
}

/**
 * Profile routes: CRUD, Bot Mode, sessions under a profile, archive and the
 * purge cascade, memory, and the export/import bundle. Profiles are REST +
 * doc (never chord objects — chord 1.4.0 replicated CRUD desyncs on attach).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { artifactsDir, destroySandbox, resolveInside, sandboxNameOf } from "@spreissen/ext";
import { taskConversationKey } from "@spreissen/mind";
import type { ProfileCreate, ProfileInfo } from "@spreissen/contracts";
import { removeCronJobsForSessions } from "../cron.ts";
import { removeWebhooksForSessions } from "../webhooks.ts";
import {
  createCronJob,
  listCronJobs,
  listSensors,
  listWebhooks,
  removeSensorsForSessions,
  sensorsService,
  webhooksService,
} from "@spreissen/mind";
import { errorOf, type RouteArgs } from "./types.ts";

const ID = "[a-zA-Z0-9][a-zA-Z0-9._-]*";

export async function profileRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  const base = path.match(/^\/api\/profiles\/([^/]+)(\/.*)?$/);
  const collect = async (body: unknown): Promise<ProfileCreate> => {
    const raw = body as ProfileCreate;
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new Error("name is required");
    }
    return raw;
  };

  if (path === "/api/profiles" && method === "GET") {
    json(200, await mind.profiles.list(args.owner));
    return true;
  }
  if (path === "/api/profiles" && method === "POST") {
    try {
      json(200, await mind.profiles.create(args.owner, await collect(await args.readJson(req))));
    } catch (cause) {
      json(400, { error: errorOf(cause) });
    }
    return true;
  }
  if (path === "/api/profiles/import" && method === "POST") {
    json(200, await importBundle(args));
    return true;
  }
  if (base === null) return false;
  const id = base[1] ?? "";
  const rest = base[2] ?? "";
  if (!new RegExp(`^${ID}$`).test(id)) {
    json(404, { error: "no route" });
    return true;
  }
  const owned = await mind.profiles.get(args.owner, id);
  if (owned === undefined) {
    json(404, { error: "unknown profile" });
    return true;
  }

  if (rest === "" && method === "GET") {
    json(200, owned);
    return true;
  }
  if (rest === "" && method === "PATCH") {
    try {
      const patch = await args.readJson<Record<string, unknown>>(req);
      const updated = await mind.profiles.update(args.owner, id, patch as never);
      // The per-bot model preference and tool set are durable agent state: a
      // change applies to every existing conversation too (main, sessions,
      // room seats), not just future ones.
      const toolsChanged =
        (patch.policies as { sandbox?: unknown } | undefined)?.sandbox !== undefined ||
        patch.toolAllowlist !== undefined;
      if (patch.model !== undefined || toolsChanged) {
        await applyAgentPreference(args, updated, toolsChanged);
      }
      json(200, updated);
    } catch (cause) {
      json(400, { error: errorOf(cause) });
    }
    return true;
  }
  if (rest === "/main" && method === "POST") {
    await mind.profiles.setMain(args.owner, id);
    json(200, { ok: true, profileId: id });
    return true;
  }
  if (rest === "" && method === "DELETE") {
    // The main bot and the last remaining bot are protected: switch main
    // first, and a workspace always keeps one bot.
    const main = await mind.profiles.mainOf(args.owner);
    if (main === id) {
      json(409, { error: "the main bot cannot be removed — switch main to another bot first" });
      return true;
    }
    const owned = await mind.profiles.list(args.owner);
    if (owned.length <= 1) {
      json(409, { error: "the last bot cannot be removed" });
      return true;
    }
    json(200, await purgeProfile(args, id));
    return true;
  }
  if (rest === "/archive" && method === "POST") {
    json(200, await mind.profiles.setArchived(args.owner, id, true));
    return true;
  }
  if (rest === "/unarchive" && method === "POST") {
    json(200, await mind.profiles.setArchived(args.owner, id, false));
    return true;
  }
  if (rest === "/sessions" && method === "GET") {
    json(200, await mind.profiles.listSessions(args.owner, id));
    return true;
  }
  if (rest === "/sessions" && method === "POST") {
    const body = await args.readJson<{ title?: string | null }>(req);
    try {
      json(200, await mind.profiles.createSession(args.owner, id, body.title ?? null));
    } catch (cause) {
      json(400, { error: errorOf(cause) });
    }
    return true;
  }
  if (rest === "/main" && method === "GET") {
    json(200, await mind.profiles.ensureMain(args.owner, id));
    return true;
  }
  if (rest === "/main/reset" && method === "POST") {
    json(200, await mind.profiles.resetMain(args.owner, id));
    return true;
  }
  if (rest === "/memory" && method === "GET") {
    json(200, await mind.memory.read(args.owner, "profile", id));
    return true;
  }
  if (rest === "/memory" && method === "POST") {
    const body = await args.readJson<{ text?: string; tags?: string[] }>(req);
    if (body.text === undefined || body.text.trim() === "") {
      json(400, { error: "text is required" });
      return true;
    }
    json(
      200,
      await mind.memory.write({
        owner: args.owner,
        writer: null,
        scope: "profile",
        profileId: id,
        text: body.text,
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      }),
    );
    return true;
  }
  const memoryRecord = rest.match(/^\/memory\/([^/]+)$/);
  if (memoryRecord !== null && method === "DELETE") {
    try {
      await mind.memory.remove(args.owner, id, memoryRecord[1] ?? "");
      json(200, { ok: true });
    } catch (cause) {
      json(404, { error: errorOf(cause) });
    }
    return true;
  }
  if (rest === "/export" && method === "GET") {
    json(200, await exportBundle(args, id));
    return true;
  }
  return false;
}

/** Owner-level memory routes (the cross-profile store). */
export async function memoryRoutes(args: RouteArgs): Promise<boolean> {
  const { req, path, mind, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/memory" && method === "GET") {
    json(200, await mind.memory.read(args.owner, "owner"));
    return true;
  }
  if (path === "/api/memory" && method === "POST") {
    const body = await args.readJson<{ text?: string; tags?: string[] }>(req);
    if (body.text === undefined || body.text.trim() === "") {
      json(400, { error: "text is required" });
      return true;
    }
    json(
      200,
      await mind.memory.write({
        owner: args.owner,
        writer: null,
        scope: "owner",
        text: body.text,
        ...(body.tags !== undefined ? { tags: body.tags } : {}),
      }),
    );
    return true;
  }
  return false;
}

/** Apply a bot's model/effort preference (and tool set, when it changed) to all its conversations. */
async function applyAgentPreference(
  args: RouteArgs,
  profile: ProfileInfo,
  toolsChanged: boolean,
): Promise<void> {
  const { mind } = args;
  // The tool override is stored as a whole: re-send the full list, or null to
  // clear it (sandbox on + no allowlist = every tool).
  const agent = toolsChanged ? mind.profiles.agentFor(profile) : undefined;
  const selection = {
    ...(profile.model === null
      ? { model: null }
      : { model: profile.model.id, effort: profile.model.effort as never }),
    ...(agent !== undefined ? { tools: agent.tools ?? null } : {}),
  };
  const configure = async (conversationId: string): Promise<void> => {
    try {
      const chat = await Effect.runPromise(mind.converse.open(conversationId));
      if (chat === undefined) return;
      await Effect.runPromise(mind.converse.configure(chat, selection));
    } catch {
      // Best-effort per conversation; one stale seat never blocks the rest.
    }
  };
  const rows = await mind.profiles.listSessions(profile.owner, profile.id);
  for (const row of rows) {
    if (row.profile !== profile.id) continue;
    const key = await mind.profiles.keyOfRow(row);
    const cid = await Effect.runPromise(mind.converse.conversationIdOf(key));
    if (cid !== undefined) await configure(cid);
  }
  // Its background tasks run as the bot too: running and later turns follow.
  for (const task of await Effect.runPromise(mind.tasks.list())) {
    if (task.bot?.owner !== profile.owner || task.bot.profileId !== profile.id) continue;
    const cid = await Effect.runPromise(
      mind.converse.conversationIdOf(taskConversationKey(task.id)),
    );
    if (cid !== undefined) await configure(cid);
  }
}

/** The purge cascade: every store a profile touches. */
async function purgeProfile(args: RouteArgs, id: string): Promise<unknown> {
  const { mind } = args;
  const sessions = await mind.profiles.remove(args.owner, id);
  const sessionIds = sessions.map((row) => row.id);
  const [mailbox, memory, vault, cron, webhooks, sensors, rooms] = await Promise.all([
    mind.mailbox.purgeProfile(args.owner, id),
    mind.memory.removeProfile(args.owner, id),
    Promise.resolve(mind.vault?.removeProfile(args.owner, id) ?? 0),
    removeCronJobsForSessions(mind.converse, sessionIds),
    removeWebhooksForSessions(mind, sessionIds),
    removeSensorsForSessions(mind.converse, sessionIds),
    mind.rooms.purgeProfile(args.owner, id),
  ]);
  let artifacts = 0;
  try {
    const dir = resolveInside(artifactsDir(), args.owner, id);
    rmSync(dir, { recursive: true, force: true });
    artifacts = sessions.length;
  } catch {
    artifacts = -1;
  }
  // The bash tool's microVM goes with the bot: same name derivation, best
  // effort (a missing VM or a stuck runtime never fails the purge).
  const sandbox = await Promise.race([
    destroySandbox(sandboxNameOf(join(artifactsDir(), args.owner, id)))
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

interface ExportBundle {
  profile: unknown;
  sessions: unknown[];
  memory: unknown[];
  vault: { info: unknown; sealed: unknown }[];
  artifacts: { info: unknown; content: string }[];
  cron: unknown[];
  webhooks: unknown[];
  sensors: unknown[];
  state: { key: string; value: string; updatedAt: number }[];
}

async function exportBundle(args: RouteArgs, id: string): Promise<unknown> {
  const { mind } = args;
  const profile = await mind.profiles.get(args.owner, id);
  if (profile === undefined) return { error: "unknown profile" };
  const [sessions, memory, cron, webhooks, sensors, state] = await Promise.all([
    mind.profiles.listSessions(args.owner, id),
    mind.memory.read(args.owner, "profile", id),
    listCronJobs(mind.converse),
    listWebhooks(mind.converse),
    listSensors(mind.converse),
    mind.state.list(id),
  ]);
  const vault = mind.vault?.list(args.owner, { profile: id }) ?? [];
  const bundle: ExportBundle = {
    profile,
    sessions: sessions.filter((row) => row.profile === id),
    memory,
    vault: vault
      .filter((info) => info.profile === id)
      .flatMap((info) => {
        const item = mind.vault?.exportItem(args.owner, info.id);
        return item === undefined ? [] : [{ info: item.info, sealed: item.sealed }];
      }),
    artifacts: [],
    cron: cron.filter((job) => job.profile === id),
    // Tokens never export: an imported webhook gets a FRESH token (counters
    // reset too — they describe this install's traffic, not the bot's).
    webhooks: webhooks
      .filter((hook) => hook.profile === id)
      .map(({ token: _token, ...hook }) => hook),
    sensors: sensors.filter((sensor) => sensor.profile === id),
    state: [...state],
  };
  return {
    ...bundle,
    note: "vault items re-open only under the same VAULT_KEY; transcripts are not exported; webhook tokens are regenerated on import",
  };
}

async function importBundle(args: RouteArgs): Promise<unknown> {
  const { mind, json } = args;
  const bundle = await args.readJson<ExportBundle>(args.req);
  const source = bundle.profile as {
    name?: string;
    description?: string;
    persona?: string;
    timezone?: string;
    model?: unknown;
    toolAllowlist?: unknown;
    policies?: unknown;
  };
  if (typeof source.name !== "string" || source.name.trim() === "") {
    return { error: "bundle.profile.name is required" };
  }
  const created = await mind.profiles.create(args.owner, {
    name: source.name,
    ...(source.description !== undefined ? { description: source.description } : {}),
    ...(source.persona !== undefined ? { persona: source.persona } : {}),
    ...(source.timezone !== undefined ? { timezone: source.timezone } : {}),
    ...(source.model !== null && source.model !== undefined
      ? { model: source.model as never }
      : {}),
    ...(source.toolAllowlist !== null && source.toolAllowlist !== undefined
      ? { toolAllowlist: source.toolAllowlist as never }
      : {}),
    ...(source.policies !== undefined ? { policies: source.policies as never } : {}),
  });
  for (const record of bundle.memory ?? []) {
    const entry = record as { text?: string; tags?: string[] };
    if (entry.text !== undefined) {
      await mind.memory.write({
        owner: args.owner,
        writer: null,
        scope: "profile",
        profileId: created.id,
        text: entry.text,
        ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
      });
    }
  }
  let vaultImported = 0;
  for (const item of bundle.vault ?? []) {
    mind.vault?.importItem(args.owner, item as never, created.id);
    vaultImported += 1;
  }
  // The routine registries rebind to the imported profile's main session:
  // schedule/webhook/sensor ids survive, session ids do not.
  const main = await mind.profiles.ensureMain(args.owner, created.id);
  const webhooks = webhooksService({ converse: mind.converse, profiles: mind.profiles });
  const sensors = sensorsService({ converse: mind.converse, profiles: mind.profiles });
  let cronImported = 0;
  for (const job of bundle.cron ?? []) {
    const row = job as {
      schedule?: string;
      once?: number | null;
      prompt?: string;
      enabled?: boolean;
    };
    if (row.prompt === undefined) continue;
    await createCronJob(mind.converse, mind.profiles, {
      sessionId: main.id,
      schedule: row.schedule ?? "",
      ...(row.once !== undefined && row.once !== null ? { once: row.once } : {}),
      prompt: row.prompt,
      ...(row.enabled !== undefined ? { enabled: row.enabled } : {}),
    });
    cronImported += 1;
  }
  let webhooksImported = 0;
  for (const hook of bundle.webhooks ?? []) {
    const row = hook as { name?: string | null; schema?: Record<string, unknown> | null };
    await webhooks.create({
      sessionId: main.id,
      ...(row.name !== undefined && row.name !== null ? { name: row.name } : {}),
      ...(row.schema !== undefined && row.schema !== null ? { schema: row.schema } : {}),
    });
    webhooksImported += 1;
  }
  let sensorsImported = 0;
  for (const sensor of bundle.sensors ?? []) {
    const row = sensor as {
      kind?: string;
      match?: string;
      leadMinutes?: number;
      url?: string | null;
    };
    if ((row.kind ?? "calendar") === "rss" && typeof row.url !== "string") continue;
    await sensors.create({
      sessionId: main.id,
      kind: row.kind === "rss" ? "rss" : row.kind === "watch" ? "watch" : "calendar",
      ...(row.kind === "rss" || row.kind === "watch" ? { url: row.url ?? "" } : {}),
      match: row.match ?? "",
      ...(row.leadMinutes !== undefined ? { leadMinutes: row.leadMinutes } : {}),
    });
    sensorsImported += 1;
  }
  let stateImported = 0;
  for (const entry of bundle.state ?? []) {
    if (typeof entry.key !== "string" || typeof entry.value !== "string") continue;
    await mind.state.set(created.id, entry.key, entry.value);
    stateImported += 1;
  }
  void json;
  return {
    ok: true,
    profile: created,
    memory: (bundle.memory ?? []).length,
    vault: vaultImported,
    cron: cronImported,
    webhooks: webhooksImported,
    sensors: sensorsImported,
    state: stateImported,
  };
}

/**
 * The wrong person can't: records filed under ANOTHER owner label (owner-b,
 * seeded straight into the mind, as an un-migrated install would hold them)
 * stay out of reach of the signed-in account (owner-a here), and every
 * refusal is word for word the answer for an id that does not exist, so a
 * probe learns nothing. Each write is checked to have left the record intact.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createCronJob, createSensor, openMind, questionTools } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-wrong-owner-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");
// A throwaway key for this test's scratch vault only.
process.env["VAULT_KEY"] = "wrong-owner-test-vault-key";

const OTHER = "owner-b";
const MISSING = "00000000-0000-4000-8000-000000000000";

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";
const theirs = { bot: "", session: "", cron: "", sensor: "", webhook: "", vault: "", task: "" };
/** Their main chat's conversation, with a question parked on it. */
let theirConversation = "";

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json" } : {}), cookie },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, raw };
};

/** The foreign id's answer must equal the missing id's, id text aside. */
const likeMissing = async (
  method: string,
  pathFor: (id: string) => string,
  id: string,
  body?: unknown,
): Promise<void> => {
  const foreign = await call(method, pathFor(id), body);
  const missing = await call(method, pathFor(MISSING), body);
  const label = `${method} ${pathFor("<id>")}`;
  expect(foreign.status, label).toBe(missing.status);
  // A refusal: an error status, or the routes' own "nothing happened".
  const refused = foreign.status >= 400 || foreign.raw === JSON.stringify({ ok: false });
  expect(refused, `${label} answered ${foreign.status} ${foreign.raw}`).toBe(true);
  expect(foreign.raw.replaceAll(id, "<id>"), label).toBe(missing.raw.replaceAll(MISSING, "<id>"));
};

beforeAll(async () => {
  handle = await openMind({ storage: new MemoryStorage(), vault: { dir: join(scratch, "vault") } });
  const { mind } = handle;
  const bot = await mind.profiles.create(OTHER, { name: "Theirs" });
  const session = await mind.profiles.ensureMain(OTHER, bot.id);
  theirs.bot = bot.id;
  theirs.session = session.id;
  theirs.cron = (
    await createCronJob(mind.converse, mind.profiles, {
      sessionId: session.id,
      schedule: "0 9 * * *",
      prompt: "tick",
    })
  ).id;
  theirs.sensor = (
    await createSensor(mind.converse, mind.profiles, {
      sessionId: session.id,
      kind: "rss",
      url: "https://example.com/feed.xml",
      match: "",
    } as Parameters<typeof createSensor>[2])
  ).id;
  theirs.webhook = (await mind.webhooks.create({ sessionId: session.id, name: "door" })).id;
  await mind.state.set(bot.id, "seen", "42");
  theirs.vault =
    mind.vault?.create(OTHER, {
      kind: "login",
      name: "Their login",
      login: { url: "https://mail.example.com", username: "b@example.com", password: "x" },
    } as never).id ?? "";
  theirs.task = (
    await Effect.runPromise(
      mind.tasks.spawn({ sessionId: session.id, owner: OTHER, conversationId: null, prompt: "dig" }),
    )
  ).id;
  theirConversation = String(
    await Effect.runPromise(mind.converse.conversationIdOf(await mind.profiles.keyOfRow(session))),
  );
  const ask = questionTools({
    profiles: mind.profiles,
    approvals: mind.approvals,
    audit: mind.audit,
  })[0];
  void ask?.execute(
    { question: "Which one?", options: [{ label: "A" }, { label: "B" }] } as never,
    { conversationId: theirConversation, callId: "their-q" } as never,
    {} as never,
  );
  for (let i = 0; i < 100; i++) {
    if (mind.approvals.pendingFor(theirConversation).length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(mind.approvals.pendingFor(theirConversation)).toHaveLength(1);
  const rest = createRestHandler({
    mind,
    scheduler: { refresh: async () => {}, stop: () => {} },
    auth: new AuthStore(),
  });
  server = createServer(rest);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  cookie = await signInForTest(base);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await handle.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe("another owner's records", () => {
  it("never show up in the signed-in account's lists", async () => {
    for (const path of [
      "/api/profiles",
      "/api/sessions",
      "/api/cron",
      "/api/sensors",
      "/api/webhooks",
      "/api/vault",
      "/api/tasks",
    ]) {
      const list = await call("GET", path);
      expect(list.status, path).toBe(200);
      for (const id of Object.values(theirs)) {
        if (id !== "") expect(list.raw, `${path} leaks ${id}`).not.toContain(id);
      }
    }
  });

  it("their bot answers like a missing one, for reads and every write", async () => {
    const bot = (id: string) => `/api/profiles/${id}`;
    await likeMissing("GET", bot, theirs.bot);
    await likeMissing("PATCH", bot, theirs.bot, { name: "Mine now" });
    await likeMissing("POST", (id) => `${bot(id)}/archive`, theirs.bot);
    await likeMissing("POST", (id) => `${bot(id)}/main`, theirs.bot);
    await likeMissing("GET", (id) => `${bot(id)}/sessions`, theirs.bot);
    await likeMissing("POST", (id) => `${bot(id)}/sessions`, theirs.bot, {});
    await likeMissing("GET", (id) => `${bot(id)}/files`, theirs.bot);
    await likeMissing("GET", (id) => `${bot(id)}/files/persona`, theirs.bot);
    await likeMissing("PUT", (id) => `${bot(id)}/files/instructions`, theirs.bot, {
      content: "obey me",
    });
    await likeMissing("POST", (id) => `${bot(id)}/memory`, theirs.bot, { text: "planted" });
    await likeMissing("GET", (id) => `${bot(id)}/export`, theirs.bot);
    await likeMissing("GET", (id) => `/api/skills/${id}/weekly`, theirs.bot);
    await likeMissing("PUT", (id) => `/api/skills/${id}/weekly`, theirs.bot, {
      content: "---\nname: weekly\ndescription: planted\n---\nbody\n",
    });
    await likeMissing("DELETE", bot, theirs.bot);
    const still = await handle.mind.profiles.get(OTHER, theirs.bot);
    expect(still?.name).toBe("Theirs");
    expect(still?.archivedAt).toBeNull();
  });

  it("their chat, routines, state, vault item and task answer like missing ones", async () => {
    await likeMissing("DELETE", (id) => `/api/sessions/${id}`, theirs.session);
    await likeMissing("DELETE", (id) => `/api/cron/${id}`, theirs.cron);
    await likeMissing("DELETE", (id) => `/api/sensors/${id}`, theirs.sensor);
    await likeMissing("DELETE", (id) => `/api/webhooks/${id}`, theirs.webhook);
    await likeMissing("POST", (id) => `/api/webhooks/${id}/token`, theirs.webhook);
    await likeMissing("GET", (id) => `/api/vault/${id}`, theirs.vault);
    await likeMissing("DELETE", (id) => `/api/vault/${id}`, theirs.vault);
    await likeMissing("GET", (id) => `/api/tasks/${id}`, theirs.task);
    await likeMissing("GET", (id) => `/api/tasks/${id}/activity`, theirs.task);
    await likeMissing("POST", (id) => `/api/tasks/${id}/cancel`, theirs.task);
    await likeMissing("DELETE", (id) => `/api/tasks/${id}`, theirs.task);
    // Reads of their bot's state and routine log come back empty, like a stranger's.
    expect((await call("GET", `/api/state?profile=${theirs.bot}`)).raw).toBe(
      (await call("GET", `/api/state?profile=${MISSING}`)).raw,
    );
    expect((await call("GET", `/api/routines/events?routine=${theirs.webhook}`)).raw).toBe(
      (await call("GET", `/api/routines/events?routine=${MISSING}`)).raw,
    );
    await call("DELETE", `/api/state/${theirs.bot}/seen`);
    // Their parked question: not listed, not decidable, still waiting.
    expect((await call("GET", "/api/approvals")).raw).not.toContain("their-q");
    await likeMissing("POST", (id) => `/api/approvals/${id}/their-q`, theirConversation, {
      approved: true,
    });
    expect(handle.mind.approvals.pendingFor(theirConversation)).toHaveLength(1);
    // Everything is still theirs.
    const rows = await handle.mind.profiles.listSessions(OTHER, theirs.bot);
    expect(rows.map((row) => row.id)).toContain(theirs.session);
    expect(handle.mind.vault?.get(OTHER, theirs.vault)).toBeDefined();
    expect(await handle.mind.state.get(theirs.bot, "seen")).toBe("42");
    expect(await Effect.runPromise(handle.mind.tasks.get(theirs.task))).toBeDefined();
  });
});

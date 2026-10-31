/**
 * Templates (slice 8): a department publishes a bot, a skill or an
 * Instructions file; another department copies it. A copy shares no memory
 * or chats with the original and carries no vault items; unpublishing
 * blocks new copies and leaves existing copies running.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openMind } from "@spriessen/mind";
import { createRestHandler } from "../rest.ts";
import { AuthStore } from "../auth/store.ts";
import { signInForTest } from "../auth/test-auth.ts";

process.env["VAULT_KEY"] = "templates-test-vault-key";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-templates-"));
process.env["AUTH_DIR"] = join(scratch, "auth");
process.env["ARTIFACTS_DIR"] = join(scratch, "artifacts");
process.env["AUDIT_LOG"] = join(scratch, "audit.jsonl");

let handle: Awaited<ReturnType<typeof openMind>>;
let server: Server;
let base = "";
let cookie = "";

const call = async (
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      cookie,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    json = raw;
  }
  return { status: response.status, json };
};

let deptA = "";
let deptB = "";
let sourceBot = "";

beforeAll(async () => {
  handle = await openMind({
    storage: new MemoryStorage(),
    vault: { dir: join(scratch, "vault") },
  });
  await handle.mind.org.ensureOrg("owner", "Personal", true);
  deptA = (await handle.mind.org.createDepartment({ name: "PubA" }, "owner")).id;
  deptB = (await handle.mind.org.createDepartment({ name: "PubB" }, "owner")).id;
  const bot = await handle.mind.profiles.create("owner", {
    name: "Template bot",
    persona: "Ship fast.",
    departmentId: deptA,
    onboard: false,
  });
  sourceBot = bot.id;
  // The bot's Instructions file and a vault item and a memory fact and a
  // chat: everything a copy must NOT carry.
  handle.mind.profiles.files?.save(bot, "instructions", "Answer with a haiku.", {
    by: "owner",
    reason: "Seed",
  });
  handle.mind.vault?.create("owner", {
    kind: "key",
    name: "Template secret",
    profile: bot.id,
    key: { secret: "sk_template_1234567890" },
  });
  await handle.mind.memory.write({
    owner: "owner",
    writer: null,
    scope: "profile",
    profileId: bot.id,
    text: "Only the source bot knows the lighthouse code.",
  });
  await handle.mind.profiles.ensureMain("owner", bot.id);
  server = createServer(
    createRestHandler({
      mind: handle.mind,
      scheduler: { refresh: async () => {}, stop: () => {} },
      auth: new AuthStore(),
    }),
  );
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

describe("publish and copy (slice 8)", () => {
  it("a bot template copy lands in the other department with its own everything", async () => {
    const published = await call("POST", "/api/org/templates", {
      kind: "bot",
      departmentId: deptA,
      botId: sourceBot,
    });
    expect(published.status).toBe(200);
    const template = published.json as { id: string; kind: string; payload: unknown };
    expect(template.kind).toBe("bot");
    // The payload carries no vault, memory or sessions.
    expect(JSON.stringify(template.payload)).not.toContain("secret");
    const copied = await call("POST", `/api/org/templates/${template.id}/copy`, {
      departmentId: deptB,
    });
    expect(copied.status).toBe(200);
    const copy = copied.json as { id: string; departmentId: string | null };
    expect(copy.departmentId).toBe(deptB);
    // Its own memory: empty, while the source knows the lighthouse code.
    const copyMemory = await handle.mind.memory.read("owner", "profile", copy.id);
    expect(JSON.stringify(copyMemory)).not.toContain("lighthouse");
    expect(JSON.stringify(await handle.mind.memory.read("owner", "profile", sourceBot))).toContain(
      "lighthouse",
    );
    // Its own chats: none copied.
    expect(await handle.mind.profiles.listSessions("owner", copy.id)).toEqual([]);
    // No vault items came along.
    expect(
      (handle.mind.vault?.list("owner", { profile: copy.id }) ?? []).filter(
        (item) => item.profile === copy.id,
      ),
    ).toEqual([]);
    // The instructions file travelled (bot files are the definition).
    const files = handle.mind.profiles.files;
    expect(files?.read({ id: copy.id, owner: "owner" } as never, "instructions").text).toContain(
      "haiku",
    );
    // The copy still runs: a main chat works for it.
    const main = await handle.mind.profiles.ensureMain("owner", copy.id);
    expect(main.profile).toBe(copy.id);
  });

  it("unpublishing blocks new copies; existing copies keep working", async () => {
    const published = (
      await call("POST", "/api/org/templates", {
        kind: "bot",
        departmentId: deptA,
        botId: sourceBot,
      })
    ).json as { id: string };
    expect((await call("DELETE", `/api/org/templates/${published.id}`)).json).toEqual({ ok: true });
    // No longer in the publisher's list.
    const list = (await call("GET", `/api/org/templates?department=${deptA}`)).json as {
      id: string;
    }[];
    expect(list.some((row) => row.id === published.id)).toBe(false);
    // A new copy is refused; the template reads as missing.
    expect(
      (await call("POST", `/api/org/templates/${published.id}/copy`, { departmentId: deptB }))
        .status,
    ).toBe(404);
  });

  it("a skill template installs onto a named bot of the target department", async () => {
    await handle.mind.skills.write("owner", sourceBot, {
      name: "deploy-note",
      body: "---\nname: deploy-note\ndescription: How this department ships\n---\n\nShip on green.",
      by: "owner",
    });
    const published = (
      await call("POST", "/api/org/templates", {
        kind: "skill",
        departmentId: deptA,
        botId: sourceBot,
        skill: "deploy-note",
      })
    ).json as { id: string };
    const target = await handle.mind.profiles.create("owner", {
      name: "Skill target",
      departmentId: deptB,
      onboard: false,
    });
    const copied = await call("POST", `/api/org/templates/${published.id}/copy`, {
      departmentId: deptB,
      botId: target.id,
    });
    expect(copied.status).toBe(200);
    const detail = await handle.mind.skills.read("owner", target.id, "deploy-note");
    expect(detail?.body).toContain("Ship on green.");
    // The source keeps its own copy.
    expect((await handle.mind.skills.read("owner", sourceBot, "deploy-note"))?.body).toContain(
      "Ship on green.",
    );
  });
});

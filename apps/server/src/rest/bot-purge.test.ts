/**
 * The purge cascade's file side: a purged bot's artifact tree, FILE TREE and
 * SKILL LIBRARY all leave the data folder with it. The file tree and skills
 * were missing from the cascade once; this pins them.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeBot } from "./bot-purge.ts";

vi.mock("../cron.ts", () => ({ removeCronJobsForSessions: vi.fn(async () => 0) }));
vi.mock("../webhooks.ts", () => ({ removeWebhooksForSessions: vi.fn(async () => 0) }));
vi.mock("@spriessen/mind", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@spriessen/mind")>();
  return { ...actual, removeSensorsForSessions: vi.fn(async () => 0) };
});

const OWNER = "owner";
const BOT = "b1";

const fakeMind = () =>
  ({
    profiles: {
      get: vi.fn(async () => ({ id: BOT, teamId: null })),
      remove: vi.fn(async () => [{ id: "s1" }, { id: "s2" }]),
    },
    org: { retireBotUser: vi.fn(async () => undefined) },
    mailbox: { purgeProfile: vi.fn(async () => 3) },
    memory: { removeProfile: vi.fn(async () => 5) },
    vault: { removeProfile: vi.fn(async () => 1) },
    rooms: { purgeProfile: vi.fn(async () => 2) },
    history: { drop: vi.fn() },
    converse: {},
  }) as never;

describe("purgeBot (the file side of the cascade)", () => {
  let scratch = "";
  let artifacts = "";
  let files = "";
  let skills = "";

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "bot-purge-"));
    artifacts = join(scratch, "artifacts");
    files = join(scratch, "bot-files");
    skills = join(scratch, "skills");
    process.env.ARTIFACTS_DIR = artifacts;
    process.env.BOT_FILES_DIR = files;
    process.env.SKILLS_DIR = skills;
    for (const dir of [
      join(artifacts, OWNER, BOT),
      join(files, OWNER, BOT),
      join(skills, OWNER, BOT, "skills", "one"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "x.txt"), "x");
    }
  });

  it("removes the artifact tree, the file tree and the skill library with the bot", async () => {
    const reply = (await purgeBot(fakeMind(), OWNER, BOT)) as {
      ok: boolean;
      artifacts: number;
      files: number;
      skills: number;
    };
    expect(reply.ok).toBe(true);
    expect(reply.artifacts).toBe(2);
    expect(reply.files).toBe(1);
    expect(reply.skills).toBe(1);
    expect(existsSync(join(artifacts, OWNER, BOT))).toBe(false);
    expect(existsSync(join(files, OWNER, BOT))).toBe(false);
    expect(existsSync(join(skills, OWNER, BOT))).toBe(false);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("a bot with no tree anywhere purges cleanly (the counts say so)", async () => {
    const reply = (await purgeBot(fakeMind(), OWNER, "never-existed")) as {
      ok: boolean;
      files: number;
      skills: number;
    };
    expect(reply.ok).toBe(true);
    expect(reply.files).toBe(1);
    expect(reply.skills).toBe(1);
    rmSync(scratch, { recursive: true, force: true });
  });
});

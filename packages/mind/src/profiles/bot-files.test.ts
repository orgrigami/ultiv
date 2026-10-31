/**
 * Persona and Instructions files (docs/BOT-FILES.md): the migration from the
 * old persona field on real-shaped throwaway rows, repeatability, versions,
 * restore, and the Persona field mirror through profiles.update.
 */
import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ProfileInfo } from "@spriessen/contracts";
import { openMind } from "../entity.ts";
import { botFiles } from "./bot-files.ts";
import { defaultPolicies } from "./docs.ts";

const row = (id: string, persona: string, owner = "owner-a"): ProfileInfo => ({
  id,
  owner,
  name: `Bot ${id}`,
  description: "Test bot",
  persona,
  timezone: "UTC",
  model: null,
  toolAllowlist: null,
  policies: defaultPolicies(),
  createdAt: 1,
  archivedAt: null,
});

const scratch = (): string => mkdtempSync(join(tmpdir(), "spriessen-bot-files-"));

describe("bot files migration", () => {
  const rows = [
    row("b1", "Calm and brief.\nSigns off with a dash."),
    row("b2", ""),
    row("b3", "x".repeat(9_000)),
    row("b4", "Formal.", "owner-b"),
  ];

  it("gives every bot both files from the old persona field", () => {
    const files = botFiles(scratch());
    expect(files.migrate(rows)).toBe(8);
    for (const bot of rows) {
      expect(files.read(bot, "persona").text).toBe(bot.persona.slice(0, 8_000));
      expect(files.read(bot, "instructions").text).toBe("");
      const [first] = files.history(bot, "persona");
      expect(first?.by).toBe("migration");
      expect(first?.n).toBe(1);
    }
  });

  it("running it twice changes nothing", () => {
    const files = botFiles(scratch());
    files.migrate(rows);
    const before = rows.map((bot) => JSON.stringify(files.history(bot, "persona")));
    expect(files.migrate(rows)).toBe(0);
    expect(rows.map((bot) => JSON.stringify(files.history(bot, "persona")))).toEqual(before);
  });

  it("refuses a scope that is not a plain name", () => {
    const files = botFiles(scratch());
    expect(() => files.read(row("../x", "p"), "persona")).toThrow();
  });
});

describe("bot file versions", () => {
  it("a save makes a version, an unchanged save does not, restore copies and keeps history", () => {
    const files = botFiles(scratch());
    const bot = row("v1", "First.");
    files.save(bot, "instructions", "Ask before booking.", { by: "owner", reason: "Rules" });
    expect(
      files.save(bot, "instructions", "Ask before booking.", { by: "owner", reason: "x" }),
    ).toBe(undefined);
    files.save(bot, "instructions", "Never ask.", { by: "owner", reason: "Changed\nmy mind" });
    const restored = files.save(bot, "instructions", "Ask before booking.", {
      by: "owner",
      reason: "Restored version 2",
      restoredFrom: 2,
    });
    expect(restored?.n).toBe(4);
    const history = files.history(bot, "instructions");
    expect(history.map((v) => v.text)).toEqual([
      "",
      "Ask before booking.",
      "Never ask.",
      "Ask before booking.",
    ]);
    expect(history[2]?.reason).toBe("Changed my mind");
    expect(files.read(bot, "instructions")).toEqual({ text: "Ask before booking.", version: 4 });
  });
});

describe("Persona edits through profiles", () => {
  it("an edit writes a Persona version and keeps the old field in step", async () => {
    const handle = await openMind({ storage: new MemoryStorage() });
    const { profiles } = handle.mind;
    const bot = await profiles.create("owner-a", {
      name: "Mirror",
      persona: "Old.",
      onboard: false,
    });
    await profiles.update("owner-a", bot.id, { persona: "New." });
    const now = await profiles.get("owner-a", bot.id);
    expect(now?.persona).toBe("New.");
    const files = profiles.files;
    expect(files).toBeDefined();
    if (now === undefined || files === undefined) return;
    expect(files.history(now, "persona").map((v) => v.text)).toEqual(["Old.", "New."]);
    // Saving the same text again adds nothing.
    await profiles.update("owner-a", bot.id, { persona: "New." });
    expect(files.history(now, "persona").length).toBe(2);
    await handle.close();
  });
});

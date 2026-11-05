/**
 * One home for everything: `~/.spriessen` (or SPRIESSEN_HOME), data in its
 * `data/` (or SPRIESSEN_DATA_DIR). An install whose old `./var/` still holds
 * the data keeps EXACTLY the old relative paths — each bot's microVM name
 * hashes the folder path as written, so a changed string would hand every
 * bot a new VM — until the home has data of its own.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { dataDir, spriessenHome, usesLegacyData } from "./home.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-home-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the Spriessen home", () => {
  it("defaults to ~/.spriessen; SPRIESSEN_HOME moves it", () => {
    expect(spriessenHome({})).toBe(join(homedir(), ".spriessen"));
    expect(spriessenHome({ SPRIESSEN_HOME: "/opt/s" })).toBe("/opt/s");
    expect(spriessenHome({ SPRIESSEN_HOME: "  " })).toBe(join(homedir(), ".spriessen"));
  });

  it("puts data in the home; SPRIESSEN_DATA_DIR wins", () => {
    const env = { SPRIESSEN_HOME: join(root, "h1") };
    expect(dataDir(env, join(root, "nowhere"))).toBe(join(root, "h1", "data"));
    expect(dataDir({ ...env, SPRIESSEN_DATA_DIR: join(root, "d") }, root)).toBe(join(root, "d"));
  });

  it("keeps an old var/ in use, as the same relative string, until the home has data", () => {
    const server = join(root, "server");
    mkdirSync(join(server, "var"), { recursive: true });
    writeFileSync(join(server, "var", "harness.sqlite"), "");
    const env = { SPRIESSEN_HOME: join(root, "h2") };
    expect(usesLegacyData(env, server)).toBe(true);
    expect(dataDir(env, server)).toBe("var");
    mkdirSync(join(root, "h2", "data"), { recursive: true });
    writeFileSync(join(root, "h2", "data", "harness.sqlite"), "");
    expect(usesLegacyData(env, server)).toBe(false);
    expect(dataDir(env, server)).toBe(join(root, "h2", "data"));
  });
});

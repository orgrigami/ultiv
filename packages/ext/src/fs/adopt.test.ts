import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  listArtifacts,
  readArtifact,
  writeArtifact,
  writeArtifactBytes,
} from "../plugins/artifacts.ts";
import { adoptAllLooseFiles, adoptLooseFiles } from "./adopt.ts";
import { DurableFs } from "./durable-fs.ts";
import { versionsOf } from "./versions.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-adopt-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("adopting loose files", () => {
  it("same-name text files become one file: the newest at the name, the rest its versions", async () => {
    const dir = tempDir();
    const old = writeArtifact(dir, { name: "board.md", content: "old" });
    await tick();
    const mid = writeArtifact(dir, { name: "board.md", content: "mid" });
    await tick();
    const newest = writeArtifact(dir, { name: "board.md", content: "new" });
    expect(await adoptLooseFiles(dir)).toBe(3);
    expect(listArtifacts(dir).map((info) => info.id)).toEqual([newest.id]);
    expect(listArtifacts(dir)[0]?.path).toBe("board.md");
    expect(versionsOf(dir, newest.id).map((v) => v.id)).toEqual([mid.id, old.id]);
    // Old chat cards still open what they showed.
    expect(readArtifact(dir, old.id)?.text).toBe("old");
    expect(await new DurableFs({ dir }).readFile("/board.md")).toBe("new");
  });

  it("other files keep apart under free names, and nothing is adopted twice", async () => {
    const dir = tempDir();
    const png = { name: "image.png", mime: "image/png", data: new Uint8Array([1, 2]) };
    const a = writeArtifactBytes(dir, png);
    const b = writeArtifactBytes(dir, png);
    expect(await adoptLooseFiles(dir)).toBe(2);
    expect(new DurableFs({ dir }).allFilePaths()).toEqual(["/image (2).png", "/image.png"]);
    expect(
      listArtifacts(dir)
        .map((info) => info.id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect(await adoptLooseFiles(dir)).toBe(0);
  });

  it("a name that is not a path still gets one, and a taken text path gets a free one", async () => {
    const dir = tempDir();
    await new DurableFs({ dir }).writeFile("/notes.md", "from bash");
    writeArtifact(dir, { name: "notes.md", content: "loose" });
    writeArtifact(dir, { name: "../up.md", content: "x" });
    await adoptLooseFiles(dir);
    expect(new DurableFs({ dir }).allFilePaths()).toEqual([
      "/..-up.md",
      "/notes (2).md",
      "/notes.md",
    ]);
  });

  it("walks every bot and team store, never the legacy root or _home", async () => {
    const root = tempDir();
    const bot = join(root, "owner", "bot-1");
    const team = join(root, "owner", "_team", "team-a");
    const home = join(root, "owner", "_home", "org");
    for (const dir of [bot, team, home]) mkdirSync(dir, { recursive: true });
    for (const dir of [root, bot, team, home]) writeArtifact(dir, { name: "a.md", content: "x" });
    expect(await adoptAllLooseFiles(root)).toBe(2);
    expect(listArtifacts(root)[0]?.path).toBeUndefined();
    expect(listArtifacts(home)[0]?.path).toBeUndefined();
    expect(listArtifacts(team)[0]?.path).toBe("a.md");
  });
});

/**
 * Skill history (Phase 1 slice 10): every write is a version with who, when
 * and why; restore and undo append, never rewrite; skills saved before full
 * history keep their two known versions; numbering survives a remove.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { skillsService } from "./service.ts";

let root: string | undefined;
const fresh = (): string => {
  root = mkdtempSync(join(tmpdir(), "spriessen-skill-versions-"));
  return root;
};
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

const BODY = (step: string): string =>
  `---\nname: weekly-report\ndescription: The weekly report\n---\n\n${step}`;

describe("skill versions", () => {
  it("records every write with its author, reason and turn", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-1", {
      name: "weekly-report",
      body: BODY("two"),
      origin: "owner",
      note: "Tightened step two",
    });
    await skills.write("owner-a", "bot-1", {
      name: "weekly-report",
      body: BODY("three"),
      by: "learning",
      turn: "conv-1#call-9",
      note: "learned: send it on Fridays",
    });
    const history = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(history.map((v) => [v.n, v.by, v.reason])).toEqual([
      [1, "bot", "Created"],
      [2, "owner", "Tightened step two"],
      [3, "learning", "learned: send it on Fridays"],
    ]);
    expect(history[2]?.turn).toBe("conv-1#call-9");
    expect(history.every((v) => typeof v.at === "number")).toBe(true);
  });

  it("restores any version and undoes the last change, both as new versions", async () => {
    const skills = skillsService({ root: fresh() });
    for (const step of ["one", "two", "three"]) {
      await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY(step) });
    }
    const restored = await skills.restore("owner-a", "bot-1", "weekly-report", 1);
    expect(restored?.version).toBe(4);
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("one");
    const undone = await skills.revert("owner-a", "bot-1", "weekly-report");
    expect(undone?.version).toBe(5);
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("three");
    const history = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(history.map((v) => [v.n, v.restoredFrom, v.reason])).toEqual([
      [1, undefined, "Created"],
      [2, undefined, "Updated"],
      [3, undefined, "Updated"],
      [4, 1, "Restored version 1"],
      [5, 3, "Undid version 4"],
    ]);
    expect(await skills.restore("owner-a", "bot-1", "weekly-report", 99)).toBeUndefined();
  });

  it("a single version has nothing to undo; built-ins have no history", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    expect(await skills.revert("owner-a", "bot-1", "weekly-report")).toBeUndefined();
    expect(await skills.versions("owner-a", "bot-1", "spriessen")).toEqual([]);
  });

  it("a skill saved before full history keeps its two known versions", async () => {
    const dir = fresh();
    const skills = skillsService({ root: dir });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("two") });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("three") });
    // As the store looked before: no history file, only the index row.
    rmSync(join(dir, "owner-a", "bot-1", "versions"), { recursive: true });
    const legacy = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(legacy.map((v) => [v.n, v.by])).toEqual([
      [2, "migration"],
      [3, "migration"],
    ]);
    expect(legacy[1]?.text).toContain("three");
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("four") });
    const after = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(after.map((v) => v.n)).toEqual([2, 3, 4]);
    expect((await skills.revert("owner-a", "bot-1", "weekly-report"))?.version).toBe(5);
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("three");
  });

  it("a removed skill's history stays, and a new one by that name numbers on", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("two") });
    await skills.remove("owner-a", "bot-1", "weekly-report");
    const again = await skills.write("owner-a", "bot-1", {
      name: "weekly-report",
      body: BODY("new"),
    });
    expect(again.version).toBe(3);
  });

  it("learn, delete, learn: undo removes the skill and never brings back the deleted text", async () => {
    const skills = skillsService({ root: fresh() });
    const learn = (step: string) =>
      skills.write("owner-a", "bot-1", {
        name: "weekly-report",
        body: BODY(step),
        by: "learning",
        note: `learned: ${step}`,
      });
    await learn("deleted text");
    await skills.remove("owner-a", "bot-1", "weekly-report");
    const again = await learn("fresh text");
    expect(again.version).toBe(2);
    const history = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(history.map((v) => [v.n, v.created === true])).toEqual([
      [1, true],
      [2, true],
    ]);
    // There is nothing of this skill's own to go back to: undo is a remove.
    expect(await skills.revert("owner-a", "bot-1", "weekly-report")).toBeUndefined();
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("fresh text");
    await skills.remove("owner-a", "bot-1", "weekly-report");
    expect(await skills.read("owner-a", "bot-1", "weekly-report")).toBeUndefined();
    // A later save in the new lineage still undoes to its own previous version.
    await learn("third");
    await learn("fourth");
    expect((await skills.revert("owner-a", "bot-1", "weekly-report"))?.version).toBe(5);
    const body = (await skills.read("owner-a", "bot-1", "weekly-report"))?.body ?? "";
    expect(body).toContain("third");
    expect(await skills.revert("owner-a", "bot-1", "weekly-report")).toBeDefined();
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("fourth");
  });

  it("every file in the skill folder is versioned: restore and undo bring them back", async () => {
    const skills = skillsService({ root: fresh() });
    const write = (step: string, files?: { path: string; content: string }[]) =>
      skills.write("owner-a", "bot-1", {
        name: "weekly-report",
        body: BODY(step),
        ...(files !== undefined ? { files } : {}),
      });
    const file = (rel: string) => skills.readFile("owner-a", "bot-1", "weekly-report", rel);
    await write("one", [
      { path: "references/format.md", content: "format one" },
      { path: "scripts/send.sh", content: "echo one" },
    ]);
    await write("two", [
      { path: "references/format.md", content: "format two" },
      { path: "references/extra.md", content: "extra" },
    ]);
    await write("three"); // body only: the files carry over, and are recorded
    const history = await skills.versions("owner-a", "bot-1", "weekly-report");
    expect(history.map((v) => v.files)).toEqual([
      { "references/format.md": "format one", "scripts/send.sh": "echo one" },
      { "references/format.md": "format two", "references/extra.md": "extra" },
      { "references/format.md": "format two", "references/extra.md": "extra" },
    ]);
    await skills.restore("owner-a", "bot-1", "weekly-report", 1);
    expect(await file("references/format.md")).toBe("format one");
    expect(await file("scripts/send.sh")).toBe("echo one");
    expect(await file("references/extra.md")).toBeUndefined();
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.meta.files).toEqual([
      "references/format.md",
      "scripts/send.sh",
    ]);
    // Undo the restore: version three's files return.
    await skills.revert("owner-a", "bot-1", "weekly-report");
    expect(await file("references/format.md")).toBe("format two");
    expect(await file("references/extra.md")).toBe("extra");
    expect(await file("scripts/send.sh")).toBeUndefined();
    // The wrong person can't restore them.
    expect(await skills.restore("owner-b", "bot-1", "weekly-report", 1)).toBeUndefined();
    expect(await file("references/format.md")).toBe("format two");
  });

  it("a version saved before files were versioned leaves the current files alone", async () => {
    const dir = fresh();
    const skills = skillsService({ root: dir });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-1", {
      name: "weekly-report",
      body: BODY("two"),
      files: [{ path: "references/format.md", content: "kept" }],
    });
    const path = join(dir, "owner-a", "bot-1", "versions", "weekly-report.versions.json");
    const stored = JSON.parse(readFileSync(path, "utf8")) as { versions: { files?: unknown }[] };
    delete stored.versions[0]?.files;
    writeFileSync(path, JSON.stringify(stored));
    await skills.restore("owner-a", "bot-1", "weekly-report", 1);
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("one");
    expect(await skills.readFile("owner-a", "bot-1", "weekly-report", "references/format.md")).toBe(
      "kept",
    );
  });

  it("the wrong person can't see or restore another owner's history", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("two") });
    expect(await skills.versions("owner-b", "bot-1", "weekly-report")).toEqual([]);
    expect(await skills.restore("owner-b", "bot-1", "weekly-report", 1)).toBeUndefined();
    expect(await skills.revert("owner-b", "bot-1", "weekly-report")).toBeUndefined();
    expect((await skills.read("owner-a", "bot-1", "weekly-report"))?.body).toContain("two");
  });

  it("a damaged history file reads as the legacy pair, not a crash", async () => {
    const dir = fresh();
    const skills = skillsService({ root: dir });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    const file = join(dir, "owner-a", "bot-1", "versions", "weekly-report.versions.json");
    expect(readFileSync(file, "utf8")).toContain("Created");
    writeFileSync(file, "{not json");
    expect((await skills.versions("owner-a", "bot-1", "weekly-report")).map((v) => v.n)).toEqual([
      1,
    ]);
  });
});

describe("skill index per bot", () => {
  it("one bot's first skill never shows in another bot's list", async () => {
    const skills = skillsService({ root: fresh() });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    const names = async (owner: string, bot: string) =>
      (await skills.list(owner, bot)).filter((m) => m.origin !== "builtin").map((m) => m.name);
    expect(await names("owner-a", "bot-1")).toEqual(["weekly-report"]);
    expect(await names("owner-a", "bot-2")).toEqual([]);
    expect(await names("owner-b", "bot-1")).toEqual([]);
  });
});

describe("rows copied in by the old shared empty index", () => {
  it("are not listed for a bot whose folder lacks the skill", async () => {
    const dir = fresh();
    const skills = skillsService({ root: dir });
    await skills.write("owner-a", "bot-1", { name: "weekly-report", body: BODY("one") });
    await skills.write("owner-a", "bot-2", {
      name: "other-skill",
      body: BODY("x").replace("weekly-report", "other-skill"),
    });
    const file = join(dir, "owner-a", "bot-2", "skills.index.json");
    const index = JSON.parse(readFileSync(file, "utf8"));
    const own = JSON.parse(
      readFileSync(join(dir, "owner-a", "bot-1", "skills.index.json"), "utf8"),
    );
    index.skills["weekly-report"] = own.skills["weekly-report"];
    writeFileSync(file, JSON.stringify(index));
    const names = (await skills.list("owner-a", "bot-2"))
      .filter((m) => m.origin !== "builtin")
      .map((m) => m.name);
    expect(names).toEqual(["other-skill"]);
  });
});

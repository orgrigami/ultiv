import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { extractSkill } from "./tarball.ts";

const BLOCK = 512;

/** One ustar header block; regular files by default. */
const header = (path: string, size: number, typeflag = "0"): Buffer => {
  const block = Buffer.alloc(BLOCK, 0);
  block.write(path, 0, Math.min(path.length, 100), "utf8");
  block.write("0000644\0", 100, 8, "utf8");
  block.write("0000000\0", 108, 8, "utf8");
  block.write("0000000\0", 116, 8, "utf8");
  block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
  block.write("00000000000\0", 136, 12, "utf8");
  block.write("        ", 148, 8, "utf8");
  block.write(typeflag, 156, 1, "utf8");
  block.write("ustar\0", 257, 6, "utf8");
  return block;
};

/** Data padded to the 512-byte block boundary. */
const padded = (content: string): Buffer => {
  const data = Buffer.from(content, "utf8");
  const fill = (BLOCK - (data.length % BLOCK)) % BLOCK;
  return Buffer.concat([data, Buffer.alloc(fill, 0)]);
};

const tarOf = (
  ...entries: readonly { path: string; typeflag?: string; content?: string }[]
): Buffer =>
  Buffer.concat(
    entries.map((entry) =>
      Buffer.concat([
        header(entry.path, entry.content?.length ?? 0, entry.typeflag ?? "0"),
        padded(entry.content ?? ""),
      ]),
    ),
  );

const SKILL = (name: string, body: string): string =>
  `---\nname: ${name}\ndescription: d\n---\n\n${body}`;

describe("extractSkill", () => {
  it("finds the shallowest SKILL.md and carries sibling files", () => {
    const tar = tarOf(
      { path: "repo/", typeflag: "5" },
      { path: "repo/SKILL.md", content: SKILL("x", "# x") },
      { path: "repo/references/deep.md", content: "details" },
      { path: "repo/scripts/run.sh", content: "echo hi" },
    );
    const skill = extractSkill(gzipSync(tar));
    expect(skill.skillMd).toContain("# x");
    expect(skill.files.map((file) => file.path)).toEqual(["references/deep.md", "scripts/run.sh"]);
    expect(skill.skipped).toEqual([]);
  });

  it("picks the folder named by `inside`, refuses unknown ones", () => {
    const tar = tarOf(
      { path: "a/SKILL.md", content: SKILL("a", "A") },
      { path: "b/SKILL.md", content: SKILL("b", "B") },
    );
    expect(extractSkill(gzipSync(tar), "b").skillMd).toContain("B");
    expect(() => extractSkill(gzipSync(tar), "zzz")).toThrow(/no SKILL.md under/);
  });

  it("skips binary files and reports them", () => {
    const binary = Buffer.from([0x4c, 0x00, 0x1f, 0x8b]).toString("latin1");
    const tar = tarOf(
      { path: "top/SKILL.md", content: SKILL("t", "T") },
      { path: "top/assets/logo.bin", content: binary },
      { path: "top/references/note.md", content: "fine" },
    );
    const skill = extractSkill(gzipSync(tar), "top");
    expect(skill.files.map((file) => file.path)).toEqual(["references/note.md"]);
    expect(skill.skipped).toEqual(["assets/logo.bin"]);
  });

  it("refuses archives with no SKILL.md", () => {
    const tar = tarOf({ path: "lonely/readme.md", content: "hi" });
    expect(() => extractSkill(gzipSync(tar))).toThrow(/holds no SKILL.md/);
  });
});

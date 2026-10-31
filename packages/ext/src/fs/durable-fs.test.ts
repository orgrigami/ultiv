import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableFs } from "./durable-fs.ts";
import { listArtifacts, readArtifact, VFS_INDEX_ID } from "../plugins/artifacts.ts";

const workspace = (): { dir: string; clean: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "spreissen-vfs-"));
  return { dir, clean: () => rmSync(dir, { recursive: true, force: true }) };
};

describe("DurableFs", () => {
  it("writes, reads, appends, and lists files", async () => {
    const { dir, clean } = workspace();
    const fs = new DurableFs({ dir });
    await fs.writeFile("/notes.md", "hello");
    expect(await fs.readFile("/notes.md")).toBe("hello");
    await fs.appendFile("/notes.md", " world");
    expect(await fs.readFile("/notes.md")).toBe("hello world");
    expect(await fs.exists("/notes.md")).toBe(true);
    expect(await fs.exists("/nope.md")).toBe(false);
    const stat = await fs.stat("/notes.md");
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBe("hello world".length);
    expect(await fs.readdir("/")).toEqual(["notes.md"]);
    clean();
  });

  it("supports directories, cp, mv and rm", async () => {
    const { dir, clean } = workspace();
    const fs = new DurableFs({ dir });
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/a.txt", "A");
    await fs.cp("/project/a.txt", "/project/b.txt");
    expect(await fs.readFile("/project/b.txt")).toBe("A");
    await fs.cp("/project", "/archive", { recursive: true });
    expect(await fs.readdir("/archive")).toEqual(["a.txt", "b.txt"]);
    await fs.mv("/project/a.txt", "/project/renamed.txt");
    expect(await fs.exists("/project/a.txt")).toBe(false);
    expect(await fs.readFile("/project/renamed.txt")).toBe("A");
    let threw = false;
    try {
      await fs.rm("/project");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true); // not empty, not recursive
    await fs.rm("/project", { recursive: true });
    expect(await fs.exists("/project")).toBe(false);
    expect(await fs.exists("/archive")).toBe(true);
    clean();
  });

  it("symlinks resolve; the index survives a restart", async () => {
    const { dir, clean } = workspace();
    const fs = new DurableFs({ dir });
    await fs.writeFile("/real.txt", "content");
    await fs.symlink("/real.txt", "/link.txt");
    expect(await fs.readlink("/link.txt")).toBe("/real.txt");
    expect(await fs.realpath("/link.txt")).toBe("/real.txt");
    expect(await fs.readFile("/link.txt")).toBe("content");
    const stat = await fs.lstat("/link.txt");
    expect(stat.isSymbolicLink).toBe(true);

    // A fresh instance — the process restarted — sees the same tree.
    const reborn = new DurableFs({ dir });
    expect(await reborn.readFile("/real.txt")).toBe("content");
    expect(await reborn.exists("/link.txt")).toBe(true);
    await reborn.rm("/real.txt");
    expect(await reborn.exists("/real.txt")).toBe(false);
    // The symlink's target is gone now.
    let dangling = false;
    try {
      await reborn.readFile("/link.txt");
    } catch {
      dangling = true;
    }
    expect(dangling).toBe(true);
    clean();
  });

  it("persists files as artifacts; the index stays reserved", async () => {
    const { dir, clean } = workspace();
    const fs = new DurableFs({ dir, conversationId: "42", owner: "harry", profile: "edison" });
    await fs.writeFile("report.md", "# Report");
    const ids = fs.artifactIds();
    expect(ids).toHaveLength(1);
    const id = ids[0] as string;
    const found = readArtifact(dir, id);
    expect(found?.text).toBe("# Report");
    expect(found?.info.profile).toBe("edison");
    expect(found?.info.name).toBe("report.md");
    // The index never shows up in artifact listings or the fs itself.
    expect(listArtifacts(dir).map((info) => info.id)).not.toContain(VFS_INDEX_ID);
    expect(await fs.readdir("/")).toEqual(["report.md"]);
    clean();
  });

  it("hard links share content until the last reference is removed", async () => {
    const { dir, clean } = workspace();
    const fs = new DurableFs({ dir });
    await fs.writeFile("/a.txt", "shared");
    await fs.link("/a.txt", "/b.txt");
    expect(await fs.readFile("/b.txt")).toBe("shared");
    await fs.writeFile("/a.txt", "changed");
    expect(await fs.readFile("/b.txt")).toBe("changed"); // same blob
    await fs.rm("/a.txt");
    expect(await fs.readFile("/b.txt")).toBe("changed"); // still referenced
    await fs.rm("/b.txt");
    expect(fs.artifactIds()).toEqual([]);
    clean();
  });
});

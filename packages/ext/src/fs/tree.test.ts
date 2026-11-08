import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { listArtifacts, readArtifact } from "../plugins/artifacts.ts";
import { artifactsPlugin } from "../plugins/artifact-tools.ts";
import { DurableFs } from "./durable-fs.ts";
import { grantInto, putFile, removeFile, restoreVersion } from "./tree.ts";
import { MAX_VERSIONS, versionsOf } from "./versions.ts";
import { workspaceEpoch } from "./workspace-epoch.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-tree-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

const bytes = (text: string): Uint8Array => Buffer.from(text, "utf8");
const put = async (dir: string, path: string, text: string, unique = false) => {
  const result = await putFile(dir, path, bytes(text), { unique, owner: "o", profile: "p" });
  if ("refused" in result) throw new Error(result.refused);
  return result;
};

describe("one tree per bot", () => {
  it("a write to a taken path replaces the file in place and keeps the old bytes", async () => {
    const dir = tempDir();
    const first = await put(dir, "/board.md", "v1");
    const second = await put(dir, "/board.md", "v2");
    expect(first.replaced).toBe(false);
    expect(second.replaced).toBe(true);
    expect(second.info.id).toBe(first.info.id);
    expect(second.info.createdAt).toBe(first.info.createdAt);
    expect(second.info.path).toBe("board.md");
    expect(listArtifacts(dir).map((info) => info.id)).toEqual([first.info.id]);
    expect(readArtifact(dir, first.info.id)?.text).toBe("v2");
    const [old] = versionsOf(dir, first.info.id);
    expect(old?.versionOf).toBe(first.info.id);
    expect(readArtifact(dir, old?.id ?? "")?.text).toBe("v1");
  });

  it("the file is in the tree bash and the file tools see, and the VM is told to reload", async () => {
    const dir = tempDir();
    const before = workspaceEpoch(dir);
    await put(dir, "/reports/board.md", "# Board");
    expect(workspaceEpoch(dir)).toBeGreaterThan(before);
    expect(await new DurableFs({ dir }).readFile("/reports/board.md")).toBe("# Board");
  });

  it("the same bytes again keep no version; versions stop at the cap", async () => {
    const dir = tempDir();
    const { info } = await put(dir, "/a.txt", "same");
    await put(dir, "/a.txt", "same");
    expect(versionsOf(dir, info.id)).toEqual([]);
    for (let i = 0; i < MAX_VERSIONS + 3; i += 1) await put(dir, "/a.txt", `v${i}`);
    expect(versionsOf(dir, info.id)).toHaveLength(MAX_VERSIONS);
    expect(listArtifacts(dir)).toHaveLength(1);
  });

  it("a unique write takes a free numbered name instead of replacing", async () => {
    const dir = tempDir();
    const a = await put(dir, "/uploads/image.png", "one", true);
    const b = await put(dir, "/uploads/image.png", "two", true);
    expect(b.info.id).not.toBe(a.info.id);
    expect(b.info.path).toBe("uploads/image (2).png");
  });

  it("refuses a path under a file, and a folder as a file", async () => {
    const dir = tempDir();
    await put(dir, "/notes", "a file");
    expect(await putFile(dir, "/notes/x.md", bytes("x"))).toEqual({
      refused: "notes is a file, not a folder",
    });
    await put(dir, "/docs/a.md", "a");
    expect("refused" in (await putFile(dir, "/docs", bytes("x")))).toBe(true);
  });

  it("an index opened before another writer never drops that writer's file", async () => {
    const dir = tempDir();
    const stale = new DurableFs({ dir });
    await put(dir, "/written-meanwhile.md", "hi");
    await stale.writeFile("/from-bash.txt", "bash");
    const fresh = new DurableFs({ dir });
    expect(fresh.allFilePaths()).toEqual(["/from-bash.txt", "/written-meanwhile.md"]);
  });

  it("removing a file drops every path, its versions and its bytes", async () => {
    const dir = tempDir();
    const { info } = await put(dir, "/a.md", "1");
    await put(dir, "/a.md", "2");
    const [version] = versionsOf(dir, info.id);
    await new DurableFs({ dir }).link("/a.md", "/b.md");
    expect(await removeFile(dir, info.id)).toBe(true);
    expect(new DurableFs({ dir }).allFilePaths()).toEqual([]);
    expect(readArtifact(dir, version?.id ?? "")).toBeUndefined();
    expect(listArtifacts(dir)).toEqual([]);
    expect(await removeFile(dir, info.id)).toBe(false);
  });

  it("restoring a version puts it back and keeps what was there", async () => {
    const dir = tempDir();
    const { info } = await put(dir, "/a.md", "good");
    await put(dir, "/a.md", "broken");
    const [good] = versionsOf(dir, info.id);
    const restored = await restoreVersion(dir, info.id, good?.id ?? "");
    expect(restored?.id).toBe(info.id);
    expect(readArtifact(dir, info.id)?.text).toBe("good");
    expect(versionsOf(dir, info.id).map((v) => readArtifact(dir, v.id)?.text)).toEqual([
      "broken",
      "good",
    ]);
    expect(await restoreVersion(dir, info.id, "nope")).toBeUndefined();
  });

  it("a moved file's record follows it", async () => {
    const dir = tempDir();
    const { info } = await put(dir, "/draft.md", "x");
    await new DurableFs({ dir }).mv("/draft.md", "/final/report.md");
    const [moved] = listArtifacts(dir);
    expect(moved).toMatchObject({ id: info.id, name: "report.md", path: "final/report.md" });
  });

  it("a granted file keeps its id and lands under received/", async () => {
    const from = tempDir();
    const to = tempDir();
    const { info } = await put(from, "/plan.md", "plan");
    expect(await grantInto(from, to, info.id)).toBe(true);
    expect(await grantInto(from, to, info.id)).toBe(true);
    expect(new DurableFs({ dir: to }).allFilePaths()).toEqual(["/received/plan.md"]);
    expect(readArtifact(to, info.id)?.text).toBe("plan");
  });
});

describe("artifact_write", () => {
  const writeTool = (root: string) => {
    const capability = artifactsPlugin({ root }).capabilities[0];
    if (capability?.kind !== "tool") throw new Error("no write tool");
    return capability.tool;
  };
  const call = (root: string, args: { name: string; content: string }) =>
    writeTool(root).execute(args, { conversationId: "c1" } as never, {} as never);

  it("writes by path: the same name twice is one file, not two", async () => {
    const root = tempDir();
    const first = await call(root, { name: "board.md", content: "one" });
    const second = await call(root, { name: "board.md", content: "two" });
    expect(second.structuredOutput).toMatchObject({ path: "board.md", replaced: true });
    expect((second.structuredOutput as { id: string }).id).toBe(
      (first.structuredOutput as { id: string }).id,
    );
    expect(listArtifacts(root)).toHaveLength(1);
  });

  it("refuses a path that leaves the bot's files", async () => {
    const root = tempDir();
    const result = await call(root, { name: "../escape.md", content: "x" });
    expect(result.isError).toBe(true);
    expect(listArtifacts(root)).toEqual([]);
  });
});

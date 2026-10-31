import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  artifactFile,
  artifactsPlugin,
  copyArtifact,
  readArtifactInfo,
  clearArtifacts,
  deleteArtifact,
  listArtifacts,
  mimeOfName,
  readArtifact,
  readArtifactBytes,
  searchArtifacts,
  writeArtifact,
  writeArtifactBytes,
} from "./artifacts.ts";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "spreissen-artifacts-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("Artifact store", () => {
  it("writes, lists newest-first and reads back", async () => {
    const dir = tempDir();
    const first = writeArtifact(dir, {
      name: "notes.md",
      content: "# hello",
      conversationId: "1",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = writeArtifact(dir, {
      name: "data.json",
      content: "{}",
      conversationId: "2",
    });
    expect(second.createdAt).toBeGreaterThan(first.createdAt);
    expect(listArtifacts(dir).map((info) => info.id)).toEqual([second.id, first.id]);
    const found = readArtifact(dir, first.id);
    expect(found?.text).toBe("# hello");
    expect(found?.info.mime).toBe("text/markdown");
    expect(found?.info.conversationId).toBe("1");
    expect(artifactFile(dir, first.id)).toContain(`${first.id}.bin`);
  });

  it("defaults uploads to conversation null (legacy sidecars read the same)", () => {
    const dir = tempDir();
    const info = writeArtifact(dir, { name: "a.txt", content: "x" });
    expect(info.conversationId).toBeNull();
    expect(readArtifact(dir, info.id)?.info.conversationId).toBeNull();
  });

  it("searches session-scoped by default and the whole workspace on request", () => {
    const dir = tempDir();
    const mine = writeArtifact(dir, {
      name: "mine.md",
      content: "ordinary words",
      conversationId: "10",
    });
    writeArtifact(dir, { name: "theirs.md", content: "ordinary words", conversationId: "11" });
    expect(searchArtifacts(dir, { conversationId: "10" }).map((info) => info.id)).toEqual([
      mine.id,
    ]);
    expect(searchArtifacts(dir, { query: "ordinary" })).toHaveLength(2);
    expect(searchArtifacts(dir, { conversationId: "11", query: "theirs" })).toHaveLength(1);
    expect(searchArtifacts(dir, { conversationId: "10", query: "theirs" })).toHaveLength(0);
  });

  it("deletes one artifact and clears the workspace", () => {
    const dir = tempDir();
    const a = writeArtifact(dir, { name: "a.txt", content: "x" });
    writeArtifact(dir, { name: "b.txt", content: "y" });
    expect(deleteArtifact(dir, a.id)).toBe(true);
    expect(deleteArtifact(dir, a.id)).toBe(false);
    expect(deleteArtifact(dir, "../escape")).toBe(false);
    expect(readArtifact(dir, a.id)).toBeUndefined();
    expect(clearArtifacts(dir)).toBe(1);
    expect(listArtifacts(dir)).toHaveLength(0);
    expect(clearArtifacts(dir)).toBe(0);
  });

  it("refuses path-shaped ids and reports unknown ones", () => {
    const dir = tempDir();
    writeArtifact(dir, { name: "a.txt", content: "x" });
    expect(readArtifact(dir, "../escape")).toBeUndefined();
    expect(artifactFile(dir, "missing")).toBeUndefined();
    expect(listArtifacts(dir)).toHaveLength(1);
  });

  it("maps mime from the name and accepts an explicit override", () => {
    expect(mimeOfName("photo.PNG")).toBe("image/png");
    const dir = tempDir();
    const info = writeArtifact(dir, { name: "blob", mime: "text/csv", content: "a,b" });
    expect(info.mime).toBe("text/csv");
  });
});

describe("artifact grants", () => {
  it("copies an artifact (blob + sidecar) between profile stores", () => {
    const base = mkdtempSync(join(tmpdir(), "spreissen-grants-"));
    try {
      const fromDir = join(base, "guest", "sender");
      const toDir = join(base, "guest", "recipient");
      const info = writeArtifact(fromDir, {
        name: "briefing.md",
        content: "# hello",
        conversationId: "1",
        owner: "guest",
        profile: "sender",
      });
      expect(copyArtifact(fromDir, toDir, info.id)).toBe(true);
      expect(readArtifactInfo(toDir, info.id)?.name).toBe("briefing.md");
      expect(copyArtifact(fromDir, toDir, "not-an-id")).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("artifact_write tool", () => {
  const api = { conversationId: "conv-1" } as never;

  it("carries file details on the UI channel", async () => {
    const root = tempDir();
    const capability = artifactsPlugin({ root }).capabilities[0];
    if (capability?.kind !== "tool") throw new Error("missing artifact_write tool");
    const result = await capability.tool.execute(
      { name: "notes.md", content: "# hi" },
      api,
      {} as never,
    );
    expect(result.isError).toBeUndefined();
    const id = (result.details as { id?: unknown }).id;
    expect(typeof id).toBe("string");
    expect(readArtifactInfo(root, String(id))?.name).toBe("notes.md");
    expect(result.details).toMatchObject({
      id,
      name: "notes.md",
      mime: "text/markdown",
      bytes: 4,
    });
  });

  it("reports oversize content without details", async () => {
    const capability = artifactsPlugin({ root: tempDir() }).capabilities[0];
    if (capability?.kind !== "tool") throw new Error("missing artifact_write tool");
    const result = await capability.tool.execute(
      { name: "big.md", content: "x".repeat(1_000_001) },
      api,
      {} as never,
    );
    expect(result.isError).toBe(true);
    expect(result.details).toBeUndefined();
  });
});

describe("binary artifacts", () => {
  it("round-trips raw bytes through writeArtifactBytes and readArtifactBytes", () => {
    const dir = tempDir();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    const info = writeArtifactBytes(dir, { name: "shot.png", data: png, conversationId: "c1" });
    expect(info.mime).toBe("image/png");
    expect(info.bytes).toBe(png.byteLength);
    const back = readArtifactBytes(dir, info.id);
    expect(back?.data).toBeInstanceOf(Buffer);
    expect(back !== undefined && Buffer.compare(back.data, Buffer.from(png)) === 0).toBe(true);
    expect(back?.info.name).toBe("shot.png");
  });

  it("artifact_read shows a viewable image under the cap and a note over it", async () => {
    const root = tempDir();
    const capability = artifactsPlugin({ root }).capabilities[1];
    if (capability?.kind !== "tool") throw new Error("missing artifact_read tool");
    const api = { conversationId: "conv-9" } as never;
    const info = writeArtifactBytes(root, {
      name: "pic.png",
      data: new Uint8Array([1, 2, 3, 4]),
    });
    const ok = await capability.tool.execute({ id: info.id }, api, {} as never);
    const image = (ok.output as readonly unknown[]).find(
      (block) => (block as { type?: string }).type === "image",
    );
    expect(image).toMatchObject({ mimeType: "image/png" });
    const big = writeArtifactBytes(root, {
      name: "big.png",
      data: new Uint8Array(2_400_000).fill(7),
    });
    const note = await capability.tool.execute({ id: big.id }, api, {} as never);
    const text = (note.output as readonly { text?: string }[])
      .map((block) => block.text ?? "")
      .join("");
    expect(text).toContain("not shown");
  });
});

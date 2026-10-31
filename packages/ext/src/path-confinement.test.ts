/**
 * Path confinement across ext's file stores: artifacts, the vault and the
 * local shell backend refuse `../`, absolute parts and symlinks that point
 * out of their folder (temp dirs only).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PathEscapeError } from "@spreissen/core";
import {
  artifactFile,
  deleteArtifact,
  listArtifacts,
  readArtifact,
  readArtifactInfo,
  writeArtifact,
} from "./plugins/artifacts.ts";
import { localShellBackend } from "./shell/backend.ts";
import { makeVaultStore } from "./vault.ts";

let scratch = "";
const fresh = (): { root: string; outside: string } => {
  scratch = mkdtempSync(join(tmpdir(), "spreissen-confine-"));
  const root = join(scratch, "root");
  const outside = join(scratch, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside-only");
  return { root, outside };
};
afterEach(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  scratch = "";
});

describe("artifact store confinement", () => {
  it("treats traversal ids as unknown", () => {
    const { root } = fresh();
    for (const id of ["../outside/secret", "/etc/passwd", "..", "a/../../b"]) {
      expect(readArtifactInfo(root, id)).toBeUndefined();
      expect(artifactFile(root, id)).toBeUndefined();
      expect(deleteArtifact(root, id)).toBe(false);
    }
  });

  it("will not read through a symlinked blob or sidecar", () => {
    const { root, outside } = fresh();
    const info = writeArtifact(root, { name: "a.txt", content: "inside", owner: null });
    unlinkSync(join(root, `${info.id}.bin`));
    symlinkSync(join(outside, "secret.txt"), join(root, `${info.id}.bin`));
    expect(readArtifact(root, info.id)).toBeUndefined();
    expect(artifactFile(root, info.id)).toBeUndefined();

    writeFileSync(join(outside, "fake.json"), JSON.stringify({ ...info, id: "fake", name: "x" }));
    symlinkSync(join(outside, "fake.json"), join(root, "fake.json"));
    expect(listArtifacts(root).map((a) => a.id)).not.toContain("fake");
    expect(readArtifactInfo(root, "fake")).toBeUndefined();
  });
});

describe("vault store confinement", () => {
  it("refuses owner labels that climb out of the vault", () => {
    const { root } = fresh();
    const store = makeVaultStore(root);
    expect(() => store.list("../outside")).toThrow(PathEscapeError);
    expect(() => store.list("/tmp")).toThrow(PathEscapeError);
    expect(store.get("owner-a", "../../outside/secret")).toBeUndefined();
  });

  it("ignores a symlinked item file", () => {
    const { root, outside } = fresh();
    mkdirSync(join(root, "owner-a", "items"), { recursive: true });
    writeFileSync(join(outside, "item.json"), JSON.stringify({ info: { id: "x" } }));
    symlinkSync(join(outside, "item.json"), join(root, "owner-a", "items", "x.json"));
    const store = makeVaultStore(root);
    expect(store.list("owner-a")).toEqual([]);
    expect(store.get("owner-a", "x")).toBeUndefined();
  });
});

describe("local shell backend confinement", () => {
  it("does not sync back or read a symlink that points out", async () => {
    const { root, outside } = fresh();
    const home = join(root, "home");
    const backend = localShellBackend(home);
    await backend.prepare([{ path: "notes.txt", bytes: new TextEncoder().encode("hi") }]);
    symlinkSync(join(outside, "secret.txt"), join(home, "leak.txt"));
    expect(await backend.listFiles()).toEqual(["notes.txt"]);
    await expect(backend.readFile("leak.txt")).rejects.toThrow(PathEscapeError);
    await expect(backend.readFile("../outside/secret.txt")).rejects.toThrow(PathEscapeError);
  });

  it("refuses to write a staged file outside home", async () => {
    const { root } = fresh();
    const backend = localShellBackend(join(root, "home"));
    await expect(
      backend.prepare([{ path: "../escaped.txt", bytes: new Uint8Array([1]) }]),
    ).rejects.toThrow(PathEscapeError);
  });
});

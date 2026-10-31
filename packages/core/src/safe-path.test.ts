import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { isSafeSegment, PathEscapeError, resolveInside, tryResolveInside } from "./safe-path.ts";

describe("resolveInside", () => {
  let scratch: string;
  let root: string;
  let outside: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "spreissen-path-"));
    root = join(scratch, "root");
    outside = join(scratch, "outside");
    mkdirSync(join(root, "a"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(root, "a", "ok.txt"), "inside");
    writeFileSync(join(outside, "secret.txt"), "outside");
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  it("accepts paths inside the root, existing or not", () => {
    expect(resolveInside(root, "a", "ok.txt")).toBe(join(root, "a", "ok.txt"));
    expect(resolveInside(root, "a/new/file.txt")).toBe(join(root, "a", "new", "file.txt"));
    expect(resolveInside(root, "a/../a/ok.txt")).toBe(join(root, "a", "ok.txt"));
  });

  it("refuses ../ traversal", () => {
    expect(() => resolveInside(root, "../outside/secret.txt")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "a", "..", "..", "outside")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "..")).toThrow(PathEscapeError);
  });

  it("refuses absolute paths and NUL bytes", () => {
    expect(() => resolveInside(root, join(outside, "secret.txt"))).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "/etc/passwd")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "a/ok.txt\0.png")).toThrow(PathEscapeError);
  });

  it("refuses a decoded %2e%2e the same as a literal ..", () => {
    expect(() => resolveInside(root, decodeURIComponent("%2e%2e/outside"))).toThrow(
      PathEscapeError,
    );
    // Still-encoded text is just an odd file name inside the root.
    expect(resolveInside(root, "%2e%2e")).toBe(join(root, "%2e%2e"));
  });

  it("refuses symlinks that point out, to files or folders", () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "a", "link.txt"));
    symlinkSync(outside, join(root, "door"));
    expect(() => resolveInside(root, "a", "link.txt")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "door", "secret.txt")).toThrow(PathEscapeError);
    expect(() => resolveInside(root, "door", "new.txt")).toThrow(PathEscapeError);
  });

  it("refuses dangling symlinks and allows links that stay inside", () => {
    symlinkSync(join(scratch, "gone"), join(root, "dangling"));
    expect(() => resolveInside(root, "dangling")).toThrow(PathEscapeError);
    symlinkSync(join(root, "a"), join(root, "alias"));
    expect(resolveInside(root, "alias", "ok.txt")).toBe(join(root, "alias", "ok.txt"));
  });

  it("works when the root itself is reached through a symlink", () => {
    symlinkSync(root, join(scratch, "via"));
    expect(resolveInside(join(scratch, "via"), "a", "ok.txt")).toBe(
      join(scratch, "via", "a", "ok.txt"),
    );
  });

  it("tryResolveInside answers undefined instead of throwing", () => {
    expect(tryResolveInside(root, "../outside")).toBeUndefined();
    expect(tryResolveInside(root, "a")).toBe(join(root, "a"));
  });
});

describe("isSafeSegment", () => {
  it("accepts plain names and refuses separators, dots and NUL", () => {
    expect(isSafeSegment("guest")).toBe(true);
    expect(isSafeSegment("3f2a-profile")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "a\\b", "a\0b"])
      expect(isSafeSegment(bad)).toBe(false);
  });
});

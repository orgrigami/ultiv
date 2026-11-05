/**
 * `spriessen data move` on real folders: it moves an old data folder into
 * the home (everything but the lock), refuses to merge into a home that
 * already has data, and does nothing when there is nothing to move.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseArgs } from "../args.ts";
import { dataMove } from "./data.ts";

const root = mkdtempSync(join(tmpdir(), "spriessen-data-move-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let saved: string | undefined;
beforeEach(() => {
  saved = process.env["SPRIESSEN_DATA_DIR"];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  if (saved === undefined) delete process.env["SPRIESSEN_DATA_DIR"];
  else process.env["SPRIESSEN_DATA_DIR"] = saved;
  vi.restoreAllMocks();
});

const oldFolder = (name: string): string => {
  const from = join(root, name, "var");
  mkdirSync(join(from, "vault"), { recursive: true });
  writeFileSync(join(from, "harness.sqlite"), "db");
  writeFileSync(join(from, "vault", "item.json"), "sealed");
  return from;
};

const move = (from: string) => dataMove(parseArgs(["data", "move", "--from", from], new Set()));

describe("data move", () => {
  it("moves everything but the lock into the data folder", async () => {
    const from = oldFolder("a");
    const to = join(root, "a-home", "data");
    process.env["SPRIESSEN_DATA_DIR"] = to;
    expect(await move(from)).toBe(0);
    expect(readFileSync(join(to, "harness.sqlite"), "utf8")).toBe("db");
    expect(readFileSync(join(to, "vault", "item.json"), "utf8")).toBe("sealed");
    expect(existsSync(join(from, "harness.sqlite"))).toBe(false);
    expect(existsSync(join(to, "server.lock"))).toBe(false);
  });

  it("never merges into data that is already there", async () => {
    const from = oldFolder("b");
    const to = join(root, "b-home", "data");
    mkdirSync(to, { recursive: true });
    writeFileSync(join(to, "harness.sqlite"), "newer");
    process.env["SPRIESSEN_DATA_DIR"] = to;
    expect(await move(from)).toBe(1);
    expect(readFileSync(join(from, "harness.sqlite"), "utf8")).toBe("db");
    expect(readFileSync(join(to, "harness.sqlite"), "utf8")).toBe("newer");
  });

  it("does nothing when the old folder holds no data", async () => {
    process.env["SPRIESSEN_DATA_DIR"] = join(root, "c-home", "data");
    expect(await move(join(root, "c-empty"))).toBe(0);
    expect(existsSync(join(root, "c-home"))).toBe(false);
  });
});

/**
 * The auth store on disk: a damaged auth.json fails CLOSED (a passcode stays
 * "set" and nothing verifies) instead of reading as "no passcode yet", which
 * would reopen the first-passcode step; the recovery command still works.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { AuthStore } from "./store.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-auth-store-test-"));
const dir = join(scratch, "auth");
process.env["AUTH_DIR"] = dir;

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a damaged auth.json", () => {
  it("keeps sign-in closed until recovery writes a fresh passcode", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "auth.json"), "{ half a file");
    const store = new AuthStore();
    expect(store.passcodeSet).toBe(true);
    expect(store.attempt("")).toBe("wrong");
    expect(store.attempt("unreadable")).toBe("wrong");

    new AuthStore().reset("a fresh passcode here");
    expect(new AuthStore().attempt("a fresh passcode here")).toBe("ok");
  });

  it("writes beside its target and leaves no temp files", () => {
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);
  });
});

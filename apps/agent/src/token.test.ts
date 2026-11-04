/**
 * Where the agent reads its pairing token: a 0600 file first, then the env
 * key, then `--token` with a warning. A file other accounts can read is
 * refused, and the env keys leave the agent's own environment once read.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { resolveToken } from "./token.ts";

const dir = mkdtempSync(join(tmpdir(), "spriessen-token-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const tokenFile = (mode: number, text = "file-token\n"): string => {
  const path = join(dir, `t-${mode.toString(8)}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};

describe("resolveToken", () => {
  it("prefers the token file, trimmed, and clears the env keys", () => {
    const env: NodeJS.ProcessEnv = {
      SPRIESSEN_NODE_TOKEN: "env-token",
      SPRIESSEN_NODE_TOKEN_FILE: tokenFile(0o600),
    };
    expect(resolveToken({ token: "flag-token" }, env)).toEqual({ token: "file-token" });
    expect(env).toEqual({});
  });

  it("refuses a token file other accounts can read", () => {
    expect(() => resolveToken({ tokenFile: tokenFile(0o644) }, {})).toThrow(/chmod 600/);
  });

  it("refuses an empty token file", () => {
    expect(() => resolveToken({ tokenFile: tokenFile(0o600, " \n") }, {})).toThrow(/empty/);
  });

  it("takes the env key before the flag", () => {
    expect(resolveToken({ token: "flag" }, { SPRIESSEN_NODE_TOKEN: "env" })).toEqual({
      token: "env",
    });
  });

  it("accepts --token with a warning, and answers undefined with nothing", () => {
    expect(resolveToken({ token: "flag" }, {})).toMatchObject({
      token: "flag",
      warning: expect.stringMatching(/--token-file/),
    });
    expect(resolveToken({}, {})).toBeUndefined();
  });
});

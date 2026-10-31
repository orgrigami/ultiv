/**
 * The server closes a socket whose session ended with one close code; the
 * live client reacts to that code by bringing the sign-in gate back. The two
 * live in different packages, so this keeps them in step.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { SIGNED_OUT_CLOSE } from "./live.ts";

const here = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(
  join(here, "../../../server/src/auth/socket-sessions.ts"),
  "utf8",
);

describe("the signed-out close code", () => {
  it("is the same on the server and in the live client", () => {
    expect(server).toContain(`export const SIGNED_OUT_CLOSE = ${SIGNED_OUT_CLOSE};`);
  });
});

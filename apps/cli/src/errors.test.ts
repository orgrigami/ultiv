/**
 * The owner never sees a stack trace or a status code: each common failure
 * reads as a sentence with its fix, and main turns every throw — the UI's
 * included — into those sentences and exit 1.
 */
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ApiError, SignInRequired } from "./client/http.ts";
import { sentenceOf } from "./errors.ts";
import { main } from "./main.ts";

const server = "http://127.0.0.1:8787";

/** A port nothing listens on: bound once, then released. */
const closedPort = async (): Promise<number> => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return typeof address === "object" && address !== null ? address.port : 0;
};

describe("sentenceOf", () => {
  it("words the usual failures with their fix", () => {
    expect(sentenceOf(new SignInRequired(), server)).toBe(
      `You're not signed in to ${server}.\nRun \`spriessen login\` first.`,
    );
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    expect(sentenceOf(refused, server)).toMatch(/^Can't reach the server at .*spriessen serve/s);
    expect(sentenceOf(new ApiError(401, "/api/auth/sign-in", "wrong passcode"), server)).toBe(
      "That passcode didn't work. Try `spriessen login` again.",
    );
    expect(sentenceOf(new ApiError(500, "/api/x", "boom at line 3"), server)).not.toContain("boom");
  });

  it("never shows a status code or a route", () => {
    const text = sentenceOf(new ApiError(404, "/api/nodes/x/roots", "unknown node"), server);
    expect(text).toBe("Unknown node.");
  });
});

describe("main", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an unreachable server is one sentence and exit 1, never a trace", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    const closed = await closedPort();
    const code = await main(["bots", "--server", `http://127.0.0.1:${closed}`]);
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(
      new RegExp(`^Can't reach the server at http://127\\.0\\.0\\.1:${closed}\\.`),
    );
    expect(lines.join("\n")).not.toMatch(/^\s+at |\.mjs:\d|\.ts:\d/m);
  });

  it("an unknown command says so in a sentence", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    expect(await main(["frobnicate"])).toBe(1);
    expect(lines).toEqual([
      "There's no `spriessen frobnicate` command.\nRun `spriessen --help` to see them all.",
    ]);
  });

  it("a typo gets a guess, and a flag the command doesn't read is refused before anything runs", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args.join(" ")));
    expect(await main(["chast"])).toBe(1);
    expect(lines[0]).toMatch(/Did you mean `spriessen chats?`\?/);
    expect(await main(["ask", "hi", "--bto", "Wren"])).toBe(1);
    expect(lines[1]).toContain("has no --bto flag. Did you mean --bot?");
  });
});

/**
 * The CLI's own plumbing: argument parsing, the private config folder
 * (0700 dir, 0600 files, a cookie saved for one server never sent to
 * another), and the service files the daemon writes (no secret in either,
 * the right entry and working folder, quoting that survives spaces).
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { allFlags, boolFlag, parseArgs, stringFlag } from "./args.ts";
import {
  credentialsPath,
  normalizeServer,
  readCredentials,
  saveCredentials,
  saveNodeToken,
  serverOf,
} from "./config.ts";
import { launchdPlist, systemdUnit, systemdWord, type UnitSpec } from "./daemon/units.ts";

describe("parseArgs", () => {
  it("reads positionals, --name value, --name=value and booleans", () => {
    const parsed = parseArgs(
      ["ask", "hello", "world", "--bot", "Wren", "--timeout=20", "--json", "--always", "x"],
      new Set(["json", "always"]),
    );
    expect(parsed.positionals).toEqual(["ask", "hello", "world", "x"]);
    expect(stringFlag(parsed, "bot")).toBe("Wren");
    expect(stringFlag(parsed, "timeout")).toBe("20");
    expect(boolFlag(parsed, "json")).toBe(true);
    expect(boolFlag(parsed, "always")).toBe(true);
  });

  it("collects a repeatable flag and stops at --", () => {
    const argv = ["node", "pair", "--root", "/a", "--root=/b", "--", "--root", "/c"];
    expect(allFlags(argv, "root")).toEqual(["/a", "/b", "/c"]);
    expect(parseArgs(argv, new Set()).positionals).toEqual(["node", "pair", "--root", "/c"]);
  });
});

describe("the config folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "spriessen-cfg-"));
  const env = { SPRIESSEN_CONFIG_DIR: join(dir, "cfg") };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("saves credentials and the node token privately", () => {
    saveCredentials({ server: "http://h:1", cookie: "spriessen_session=abc", savedAt: 1 }, env);
    expect(statSync(credentialsPath(env)).mode & 0o777).toBe(0o600);
    expect(statSync(env.SPRIESSEN_CONFIG_DIR).mode & 0o777).toBe(0o700);
    expect(readCredentials(env)?.cookie).toBe("spriessen_session=abc");
    expect(statSync(saveNodeToken("tok", env)).mode & 0o777).toBe(0o600);
  });

  it("picks the server: flag, env, saved, default", () => {
    expect(serverOf("h2:9", env)).toBe("http://h2:9");
    expect(serverOf(undefined, { ...env, SPRIESSEN_SERVER_URL: "https://x.ts.net/" })).toBe(
      "https://x.ts.net",
    );
    expect(serverOf(undefined, env)).toBe("http://h:1");
    expect(serverOf(undefined, { SPRIESSEN_CONFIG_DIR: join(dir, "none") })).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeServer("https://a/")).toBe("https://a");
  });
});

const spec = (role: UnitSpec["role"]): UnitSpec => ({
  role,
  node: "/opt/node 26/bin/node",
  entry: "/repo/apps/cli/src/main.ts",
  args:
    role === "server"
      ? ["serve", "--port", "8787"]
      : ["node", "--server", "https://h", "--token-file", "/home/u/.config/spriessen/node-token"],
  workingDir: "/repo/apps/server",
  logFile: "/home/u/Library/Logs/spriessen-server.log",
});

describe("the daemon's service files", () => {
  it("systemd: the CLI entry with serve, restart on failure, quoted paths", () => {
    const unit = systemdUnit(spec("server"));
    expect(unit).toContain(
      'ExecStart="/opt/node 26/bin/node" --disable-warning=ExperimentalWarning /repo/apps/cli/src/main.ts serve --port 8787',
    );
    expect(unit).toContain("WorkingDirectory=/repo/apps/server");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(systemdWord('a "b"')).toBe('"a \\"b\\""');
  });

  it("launchd: keep-alive on crash, logs to the user's Logs, the token only by file path", () => {
    const plist = launchdPlist(spec("node"));
    expect(plist).toContain("<string>id.spriessen.node</string>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<string>--token-file</string>");
    expect(plist).not.toMatch(/SPRIESSEN_NODE_TOKEN=/);
  });
});

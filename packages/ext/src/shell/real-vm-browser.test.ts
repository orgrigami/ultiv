/**
 * The opt-in REAL-VM browser suite: the broker in a real microVM with TWO
 * bot users. Proves what only a VM can: the broker runs as the browser
 * user, its socket and chromium are out of a bot's reach (a bot's `bash`
 * cannot connect, and there is no debug port), each bot's session keeps its
 * own cookies, the bot's home stays untouched, and the live cast streams.
 * `SPRIESSEN_REAL_VM=1 vp test --run packages/ext/src/shell/real-vm-browser.test.ts`
 * boots one throwaway microsandbox VM (name `spriessen-rvtb-*`) and
 * destroys it afterwards. Never touches a live VM.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellBackend } from "./backend.ts";
import { destroySandbox, sandboxShellBackend } from "./sandbox-backend.ts";
import { brokerClient } from "../browser/broker-client.ts";
import { VM_BROKER_PATHS } from "../browser/broker-install.ts";

const REAL = process.env.SPRIESSEN_REAL_VM === "1";
const T = 600_000;
const tag = Math.random().toString(36).slice(2, 8);
const VM = `spriessen-rvtb-${tag}`;
const alice = { name: "bot-rvtba", uid: 20_104, gid: 20_104, home: "/home/rvtba" };
const bob = { name: "bot-rvtbb", uid: 20_105, gid: 20_105, home: "/home/rvtbb" };
const SITE = "http://127.0.0.1:8077";
// Two bots browsing at once need 1 GiB: the broker sizes its cap from the
// VM's memory, and 512 MiB holds one (docs/CAPACITY.md).
const TWO_BOTS = { cpus: 1, memoryMiB: 1024 };

const suite = REAL ? describe : describe.skip;

suite(
  `real VM browser broker (${REAL ? "verifying" : "NOT VERIFIED: set SPRIESSEN_REAL_VM=1"})`,
  () => {
    let scratch = "";
    let a: ShellBackend;
    let b: ShellBackend;
    const client = brokerClient();

    beforeAll(async () => {
      const stage = join(homedir(), "workspace", ".ultiv-stage", "tmp");
      mkdirSync(stage, { recursive: true });
      scratch = mkdtempSync(join(stage, "rvtb-"));
      a = sandboxShellBackend({
        name: VM,
        guestRoot: alice.home,
        user: alice,
        netOpen: false,
        vm: TWO_BOTS,
      })(join(scratch, "a"));
      b = sandboxShellBackend({
        name: VM,
        guestRoot: bob.home,
        user: bob,
        netOpen: false,
        vm: TWO_BOTS,
      })(join(scratch, "b"));
      await a.prepare([]);
      await b.prepare([]);
      await a.exec(
        [
          `mkdir -p ${alice.home}/site`,
          // A quoted heredoc: the page's own quotes never meet the shell.
          `cat > ${alice.home}/site/page.html <<'__PAGE__'`,
          `<title>Page</title><form onsubmit="event.preventDefault(); document.cookie='sid=1; max-age=999'; document.title='in'"><input name=u><button>go</button></form>`,
          "__PAGE__",
          // Detached in a subshell: the page server must outlive this exec.
          `(nohup python3 -m http.server 8077 --directory ${alice.home}/site >/dev/null 2>&1 &); sleep 1`,
        ].join("\n"),
        "/home",
        30_000,
      );
    }, T);

    afterAll(async () => {
      await destroySandbox(VM).catch(() => {});
      rmSync(scratch, { recursive: true, force: true });
    }, T);

    it(
      "starts as the browser user, out of every bot's reach",
      async () => {
        const before = await a.exec(`ls -a ${alice.home}`, "/home", 30_000);
        const opened = await client.call(a, {
          op: "open",
          bot: alice.name,
          conv: "c-a",
          url: `${SITE}/page.html`,
        });
        expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, title: "Page" });
        const owner = await a.rootExec?.(
          `stat -c %U ${VM_BROKER_PATHS.run} && pgrep -u spbrowser -c chrom`,
          30_000,
        );
        expect(owner?.stdout).toContain("spbrowser");
        // A bot's bash: no socket it may open, no debug port to dial.
        const poke = await a.exec(
          `ls ${VM_BROKER_PATHS.run} 2>&1; curl -s -m 2 http://127.0.0.1:9222/json/version || echo no-port`,
          "/home",
          30_000,
        );
        expect(poke.stdout).toContain("Permission denied");
        expect(poke.stdout).toContain("no-port");
        const after = await a.exec(`ls -a ${alice.home}`, "/home", 30_000);
        expect(after.stdout).toBe(before.stdout);
      },
      T,
    );

    it(
      "keeps each bot's cookies to itself",
      async () => {
        await client.call(a, {
          op: "type",
          bot: alice.name,
          conv: "c-a",
          selector: "input",
          text: "x",
        });
        await client.call(a, { op: "press", bot: alice.name, conv: "c-a", key: "Enter" });
        const mine = await client.call(a, {
          op: "cookies_export",
          bot: alice.name,
          conv: "c-a",
          domains: ["127.0.0.1"],
        });
        expect(mine.cookies).toEqual([expect.objectContaining({ name: "sid" })]);
        await client.call(b, { op: "open", bot: bob.name, conv: "c-b", url: `${SITE}/page.html` });
        const theirs = await client.call(b, {
          op: "cookies_export",
          bot: bob.name,
          conv: "c-b",
          domains: ["127.0.0.1"],
        });
        expect(theirs.cookies).toEqual([]);
      },
      T,
    );

    it(
      "streams a live cast as root",
      async () => {
        const stream = await client.relay(a, 120_000);
        const lines: Record<string, unknown>[] = [];
        let buffer = "";
        stream.onChunk((chunk) => {
          if (!chunk.stdout) return;
          buffer += Buffer.from(chunk.data).toString("utf-8");
          const parts = buffer.split("\n");
          buffer = parts.pop() ?? "";
          for (const part of parts)
            if (part.trim() !== "") lines.push(JSON.parse(part) as Record<string, unknown>);
        });
        await stream.write(
          `${JSON.stringify({ op: "cast", bot: alice.name, drive: true, w: 640, h: 400 })}\n`,
        );
        for (let i = 0; i < 100 && !lines.some((line) => line.t === "frame"); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(lines.some((line) => line.t === "ready")).toBe(true);
        expect(lines.some((line) => line.t === "frame")).toBe(true);
        await stream.stop();
      },
      T,
    );
  },
);

it.skipIf(REAL)(
  "real-VM browser suite: NOT VERIFIED in this run (set SPRIESSEN_REAL_VM=1 to run it)",
  () => {
    expect(REAL).toBe(false);
  },
);

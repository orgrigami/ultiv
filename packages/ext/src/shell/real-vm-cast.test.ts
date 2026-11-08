/**
 * The opt-in REAL-VM cast suite: the live takeover channel end to end on a
 * throwaway VM — the cast boots chromium itself, pins the viewport, streams
 * a frame per repaint, and the owner's ACTS drive the page as real input:
 * a tap by coordinates focuses a field, insertText types into it, Enter
 * submits the form. The page is served from the VM's own loopback (an
 * absolutely-positioned field at a known spot, so the tap's coordinate
 * mapping is exact). `SPRIESSEN_REAL_VM=1 vp test --run
 * packages/ext/src/shell/real-vm-cast.test.ts` boots one throwaway
 * microsandbox VM (name `spriessen-rvtcast-*`) and destroys it afterwards.
 * Never touches a live VM.
 */
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ShellBackend, ShellStream } from "./backend.ts";
import { destroySandbox, sandboxShellBackend } from "./sandbox-backend.ts";
import { driverCallScript } from "../browser/driver.ts";
import { castLaunchScript, CAST_VIEW } from "../browser/cast-driver.ts";

const REAL = process.env.SPRIESSEN_REAL_VM === "1";
const T = 600_000;
const tag = Math.random().toString(36).slice(2, 8);
const VM = `spriessen-rvtcast-${tag}`;
const user = { name: "bot-rvtcast", uid: 20_116, gid: 20_116, home: "/home/rvtcast" };

const suite = REAL ? describe : describe.skip;

/** The form page the cast will drive: a field pinned at a known spot. */
const PAGE = `<!doctype html><html><head><title>cast-target</title></head><body>
<form onsubmit="event.preventDefault(); document.title='submitted:' + document.getElementById('field').value;">
<input id="field" autocomplete="off" style="position:absolute;left:640px;top:400px;width:200px;height:40px;font-size:16px;">
<div id="mirror"></div>
</form>
<script>
var f = document.getElementById('field');
f.addEventListener('input', function () {
  document.getElementById('mirror').textContent = 'mirror:' + f.value;
});
</script>
</body></html>`;

type Line = { readonly [key: string]: unknown };

/** Collects the cast's stdout lines; `wait` resolves on the first match. */
class CastChannel {
  private readonly lines: Line[] = [];
  private readonly waiters: { test: (line: Line) => boolean; resolve: (line: Line) => void }[] = [];

  constructor(private readonly stream: ShellStream) {
    stream.onChunk((chunk) => {
      if (!chunk.stdout) return;
      for (const text of Buffer.from(chunk.data).toString("utf-8").split("\n")) {
        if (!text.trim().startsWith("{")) continue;
        const parsed = JSON.parse(text) as Line;
        this.lines.push(parsed);
        for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
          const waiter = this.waiters[i];
          if (waiter === undefined) continue;
          if (waiter.test(parsed)) {
            this.waiters.splice(i, 1);
            waiter.resolve(parsed);
          }
        }
      }
    });
  }

  send(act: Record<string, unknown>): Promise<void> {
    return this.stream.write(`${JSON.stringify(act)}\n`);
  }

  wait(test: (line: Line) => boolean, ms: number): Promise<Line> {
    const seen = this.lines.find(test);
    if (seen !== undefined) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) this.waiters.splice(at, 1);
        const tail = this.lines
          .slice(-5)
          .map((line) => JSON.stringify(line).slice(0, 160))
          .join(" | ");
        reject(new Error(`no cast line matched within ${ms}ms; saw ${this.lines.length}: ${tail}`));
      }, ms);
      const waiter = {
        test,
        resolve: (line: Line) => {
          clearTimeout(timer);
          resolve(line);
        },
      };
      this.waiters.push(waiter);
    });
  }
}

/** One driver command, answered the way the plugin reads it: the last JSON line. */
const drive = async (backend: ShellBackend, op: Record<string, unknown>) => {
  const result = await backend.exec(driverCallScript(JSON.stringify(op)), "/home", 90_000);
  const line = result.stdout
    .split("\n")
    .toReversed()
    .find((candidate) => candidate.startsWith("{"));
  return line === undefined
    ? { ok: false, error: result.stderr.trim().slice(0, 200) }
    : JSON.parse(line);
};

suite(
  `real VM browser cast (${REAL ? "verifying" : "NOT VERIFIED: set SPRIESSEN_REAL_VM=1"})`,
  () => {
    let scratch = "";
    let backend: ShellBackend;
    const previousArtifacts = process.env.ARTIFACTS_DIR;

    beforeAll(async () => {
      const stage = join(homedir(), "workspace", ".ultiv-stage", "tmp");
      mkdirSync(stage, { recursive: true });
      scratch = mkdtempSync(join(stage, "rvtcast-"));
      process.env.ARTIFACTS_DIR = join(scratch, "artifacts");
      mkdirSync(process.env.ARTIFACTS_DIR, { recursive: true });
      backend = sandboxShellBackend({ name: VM, guestRoot: user.home, user })(join(scratch, "b"));
      await backend.prepare([{ path: "site/page.html", bytes: Buffer.from(PAGE) }]);
      // The cast's target page, served from the VM's own loopback.
      await backend.exec(
        `nohup python3 -m http.server 8077 --directory ${user.home}/site ` +
          `>${user.home}/http.log 2>&1 & sleep 0.5; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8077/page.html`,
        "/home",
        30_000,
      );
    }, T);

    afterAll(async () => {
      await backend
        ?.exec(driverCallScript(JSON.stringify({ op: "close" })), "/home", 30_000)
        .catch(() => {});
      await destroySandbox(VM).catch(() => {});
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      rmSync(scratch, { recursive: true, force: true });
    }, T);

    it(
      "casts the page live and drives it with taps, typing and keys",
      async () => {
        if (backend.stream === undefined) throw new Error("the sandbox backend cannot stream");
        const stream = await backend.stream(castLaunchScript(), "/home", 120_000);
        const channel = new CastChannel(stream);
        const closed = new Promise<unknown[]>((resolve) => {
          const seen: unknown[] = [];
          stream.onExit((code) => {
            seen.push(code);
            resolve(seen);
          });
        });

        // The cast announces itself, then the viewport is pinned.
        await channel.wait((line) => line.t === "ready", 30_000);

        // Cold boot: the cast's own ensure_browser starts chromium.
        await channel.send({ a: "nav", url: "http://127.0.0.1:8077/page.html" });
        const onPage = await channel.wait(
          (line) => line.t === "frame" && String(line.url ?? "").includes("8077"),
          45_000,
        );
        expect(Number(onPage.w)).toBe(CAST_VIEW.width);
        expect(Number(onPage.h)).toBe(CAST_VIEW.height);
        expect(String(onPage.data)).toMatch(/^\/9j\//);

        // A tap by coordinates lands in the field; typing fills it.
        await channel.send({ a: "tap", x: 740, y: 420, id: onPage.id });
        await channel.wait((line) => line.t === "frame" && line.id !== onPage.id, 15_000);
        await channel.send({ a: "type", text: "hello" });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const facts = await drive(backend, { op: "read" });
        const mirror = await drive(backend, { op: "read", selector: "#mirror" });
        // The body text carries the mirror line: the tap focused the field
        // and the typing landed — coordinate mapping and input both hold.
        expect(facts).toMatchObject({
          ok: true,
          url: "http://127.0.0.1:8077/page.html",
          title: "cast-target",
        });
        expect(String(facts.text ?? "")).toContain("mirror:hello");
        expect(mirror).toMatchObject({ ok: true, text: "mirror:hello" });

        // Enter submits the form; the page says so in its title.
        await channel.send({ a: "key", key: "Enter" });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const page = await drive(backend, { op: "read" });
        expect(page.title).toBe("submitted:hello");
        expect(page.ok).toBe(true);

        // A graceful stop ends the stream.
        await channel.send({ a: "stop" });
        await expect(closed).resolves.toHaveLength(1);
      },
      T,
    );
  },
);

it.skipIf(REAL)(
  "real-VM cast suite: NOT VERIFIED in this run (set SPRIESSEN_REAL_VM=1 to run it)",
  () => {
    expect(REAL).toBe(false);
  },
);

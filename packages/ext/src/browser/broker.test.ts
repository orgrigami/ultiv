/**
 * The browser broker for real, on this machine: the install/start/call
 * scripts run through the local backend (no VM, no users — "root" is this
 * process), against a real chromium and a tiny local site. Proves the
 * per-bot contexts (cookies never cross), the holder refusal, popups,
 * dialogs, downloads, the chooser upload and the host-checked login fill.
 * Skipped when no chromium is found (SPRIESSEN_TEST_CHROMIUM names one).
 * The two-users-in-a-VM half is the opt-in real-VM suite.
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { localShellBackend } from "../shell/backend.ts";
import { brokerClient, type BrokerReply } from "./broker-client.ts";
import type { BrokerPaths } from "./broker-install.ts";

const findChromium = (): string | undefined => {
  const named = process.env.SPRIESSEN_TEST_CHROMIUM;
  if (named !== undefined && existsSync(named)) return named;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  for (const dir of readdirSync(cache)
    .filter((name) => /^chromium-\d+$/.test(name))
    .toReversed()) {
    const binary = join(cache, dir, "chrome-linux64", "chrome");
    if (existsSync(binary)) return binary;
  }
  return undefined;
};

const chromium = findChromium();

const PAGES: Record<string, string> = {
  "/": `<html><head><title>Home</title></head><body><h1>Home</h1>
<a id="login" href="/login">Sign in</a>
<button id="pop" onclick="window.open('/popup','p','width=400,height=300')">Open popup</button>
<button id="ask" onclick="document.title = confirm('Sure?') ? 'yes' : 'no'">Confirm</button>
<a id="dl" href="/file.txt" download="report.txt">Download</a>
<input type="file" id="f" onchange="document.title = 'got ' + this.files[0].name"></body></html>`,
  "/login": `<html><head><title>Login</title></head><body>
<form onsubmit="event.preventDefault(); document.cookie = 'sid=s3cret; max-age=3600';
document.title = 'Signed in ' + this.u.value + ' ' + this.p.value.length">
<input name="u" type="email" placeholder="Email"><input name="p" type="password"><button>Go</button>
</form></body></html>`,
  "/popup": "<html><head><title>Popup</title></head><body>popup</body></html>",
  "/file.txt": "hello file\n",
};

describe.skipIf(chromium === undefined)("the browser broker (local chromium)", () => {
  let server: Server;
  let site = "";
  let root = "";
  let paths: BrokerPaths;
  const backend = localShellBackend(mkdtempSync(join(tmpdir(), "sp-broker-ws-")));
  const client = brokerClient(
    // Paths are filled in beforeAll; the client reads them per call.
    new Proxy({} as BrokerPaths, { get: (_target, key) => paths[key as keyof BrokerPaths] }),
  );
  const call = (request: Record<string, unknown>, viaStdin = false): Promise<BrokerReply> =>
    client.call(backend, request, { viaStdin });

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "sp-broker-"));
    paths = {
      install: join(root, "i"),
      run: join(root, "r"),
      data: join(root, "d"),
      user: null,
      chromium: chromium ?? "chromium",
      tmp: join(root, "t"),
    };
    server = createServer((req, res) => {
      const body = PAGES[req.url ?? "/"];
      res.writeHead(body === undefined ? 404 : 200, {
        "content-type": req.url === "/file.txt" ? "text/plain" : "text/html",
      });
      res.end(body ?? "missing");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    site = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });

  afterAll(async () => {
    try {
      process.kill(Number(readFileSync(join(paths.run, "broker.pid"), "utf8")), "SIGTERM");
    } catch {
      // Never started.
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  it("starts on demand and gives each bot its own session", { timeout: 90_000 }, async () => {
    // The very first call starts the broker and chromium; on a machine busy
    // with the whole suite that can miss once — the second try must not.
    let opened = await call({ op: "open", bot: "a", conv: "c1", url: `${site}/` });
    if (opened.ok !== true) {
      console.warn("broker first open missed once:", JSON.stringify(opened));
      opened = await call({ op: "open", bot: "a", conv: "c1", url: `${site}/` });
    }
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, title: "Home" });
    expect(await call({ op: "open", bot: "a", conv: "c2", url: `${site}/` })).toMatchObject({
      ok: false,
      kind: "busy",
      error: "c1",
    });
    const snap = await call({ op: "snapshot", bot: "a", conv: "c1" });
    expect(snap.elements).toEqual(expect.arrayContaining(['[2] button "Open popup"']));
    expect(await call({ op: "open", bot: "b", conv: "c3", url: `${site}/` })).toMatchObject({
      ok: true,
    });
  });

  it(
    "signs in with the host check, and cookies never cross bots",
    { timeout: 60_000 },
    async () => {
      await call({ op: "open", bot: "a", conv: "c1", url: `${site}/login` });
      const wrong = await call(
        {
          op: "fill_login",
          bot: "a",
          conv: "c1",
          hosts: ["example.com"],
          username: "x",
          password: "y",
        },
        true,
      );
      expect(wrong).toMatchObject({ ok: false, kind: "host" });
      const host = new URL(site).host;
      const filled = await call(
        {
          op: "fill_login",
          bot: "a",
          conv: "c1",
          hosts: [host],
          username: "me@x.co",
          password: "pw1234",
        },
        true,
      );
      expect(filled).toMatchObject({ ok: true, filled: ["username", "password"] });
      expect(await call({ op: "press", bot: "a", conv: "c1", key: "Enter" })).toMatchObject({
        title: "Signed in me@x.co 6",
      });
      const mine = await call({
        op: "cookies_export",
        bot: "a",
        conv: "c1",
        domains: ["127.0.0.1"],
      });
      expect(mine.cookies).toEqual([expect.objectContaining({ name: "sid", value: "s3cret" })]);
      const theirs = await call({
        op: "cookies_export",
        bot: "b",
        conv: "c3",
        domains: ["127.0.0.1"],
      });
      expect(theirs.cookies).toEqual([]);
    },
  );

  it(
    "follows popups, answers dialogs, keeps downloads, uploads to a chooser",
    { timeout: 60_000 },
    async () => {
      await call({ op: "open", bot: "a", conv: "c1", url: `${site}/` });
      expect(await call({ op: "click", bot: "a", conv: "c1", selector: "#pop" })).toMatchObject({
        title: "Popup",
        session: expect.objectContaining({ popup: true }),
      });
      await call({ op: "open", bot: "a", conv: "c1", url: `${site}/` });
      const asked = await call({ op: "click", bot: "a", conv: "c1", selector: "#ask" });
      expect(asked.session).toMatchObject({ dialog: { type: "confirm", message: "Sure?" } });
      await call({ op: "dialog", bot: "a", conv: "c1", accept: true });
      expect(await call({ op: "read", bot: "a", conv: "c1" })).toMatchObject({ title: "yes" });
      const clicked = await call({ op: "click", bot: "a", conv: "c1", selector: "#dl" });
      let downloads = (clicked.session as { downloads?: { guid: string }[] }).downloads;
      for (let i = 0; downloads === undefined && i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const status = await call({ op: "status", bot: "a" });
        downloads = (status.session as { downloads?: { guid: string }[] }).downloads;
      }
      const taken = await call({
        op: "take_download",
        bot: "a",
        conv: "c1",
        guid: downloads?.[0]?.guid,
      });
      expect(Buffer.from(String(taken.data), "base64").toString()).toBe("hello file\n");
      await call({ op: "click", bot: "a", conv: "c1", selector: "#f" });
      const data = Buffer.from("hi").toString("base64");
      await call({ op: "upload", bot: "a", conv: "c1", name: "note.txt", data }, true);
      expect(await call({ op: "read", bot: "a", conv: "c1" })).toMatchObject({
        title: "got note.txt",
      });
    },
  );

  it("closes only for the holder, or by force", { timeout: 30_000 }, async () => {
    expect(await call({ op: "close", bot: "a", conv: "c9" })).toMatchObject({ kind: "busy" });
    expect(await call({ op: "close", bot: "a", conv: "c9", force: true })).toMatchObject({
      closed: true,
    });
    expect(await call({ op: "status", bot: "a" })).toMatchObject({ session: null });
  });
});

/**
 * The browser-session tool against a FAKE backend that answers the broker's
 * one-line protocol: page facts and the session summary, the busy and
 * password refusals, a screenshot and a download saved to the bot's files,
 * an upload of the bot's own file, the site check forwarded, the takeover
 * round trip (acts refused while the owner holds, the call blocking until
 * the owner closes it, a stopped turn closing it), the act-only gate, the
 * per-bot list, the idle and task-end closes, and sign-ins saved on close
 * and restored on the next first open. The broker itself is exercised for
 * real in browser/broker.test.ts.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellBackend, ShellExecResult, ShellFile } from "../shell/backend.ts";
import { listArtifacts } from "./artifacts.ts";
import { putFile } from "../fs/tree.ts";
import { browserSessionFacility, browserActText } from "./browser-session.ts";
import type { SavedSignin, SigninStore } from "../browser/signins.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-browser-session-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Request = { op: string; conv?: string; [key: string]: unknown };

const session = (extra: Record<string, unknown> = {}) => ({
  url: "https://example.test/page",
  title: "A page",
  popup: false,
  popups: 0,
  ...extra,
});

/** Answers broker JSON for the request in the call script's heredoc; records every request. */
const fakeBackend = (seen: Request[], overrides: Record<string, unknown> = {}): ShellBackend => ({
  prepare: async (_files: readonly ShellFile[]) => undefined,
  exec: async (script: string): Promise<ShellExecResult> => {
    const body = script.split("<<'__SP_REQ_EOF__'\n")[1]?.split("\n__SP_REQ_EOF__")[0] ?? "{}";
    const request = JSON.parse(body) as Request;
    seen.push(request);
    const replies: Record<string, unknown> = {
      open: { ok: true, url: "https://example.test/page", title: "A page", session: session() },
      read: {
        ok: true,
        url: "https://example.test/page",
        title: "A page",
        text: "just the field",
        session: session(),
      },
      snapshot: {
        ok: true,
        url: "https://example.test/page",
        title: "A page",
        text: "",
        elements: ['[1] button "Go"'],
        session: session(),
      },
      click: {
        ok: true,
        url: "https://example.test/after",
        title: "After",
        session: session({ downloads: [{ guid: "g1", name: "report.pdf", size: 4 }] }),
      },
      take_download: { ok: true, name: "report.pdf", data: Buffer.from("%PDF").toString("base64") },
      type: { ok: false, kind: "password", error: "password fields are refused" },
      press: { ok: false, kind: "busy", error: "conv-other" },
      upload: { ok: true, uploaded: "note.txt", session: session() },
      shot: { ok: true, png: PNG, session: session() },
      close: { ok: true, closed: true },
      cookies_export: {
        ok: true,
        cookies: [{ name: "sid", value: "v", domain: ".example.test" }],
        ua: "UA/1",
      },
      cookies_import: { ok: true, restored: 1, session: session({ url: "about:blank" }) },
      hold: { ok: true },
      ...overrides,
    };
    return {
      stdout: `${JSON.stringify(replies[request.op] ?? { ok: false, error: "unknown op" })}\n`,
      stderr: "",
      exitCode: 0,
    };
  },
  listFiles: async () => [],
  readFile: async () => new Uint8Array(),
});

const rig = (
  options: { signins?: SigninStore; idleMs?: number; overrides?: Record<string, unknown> } = {},
) => {
  const seen: Request[] = [];
  const facility = browserSessionFacility({
    root: scratch,
    backend: () => fakeBackend(seen, options.overrides),
    signins: options.signins ?? null,
    ...(options.idleMs !== undefined ? { idleMs: options.idleMs } : {}),
  });
  const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
  if (capability?.kind !== "tool") throw new Error("no browser_session tool");
  return { tool: capability.tool, facility, seen };
};

const api = { conversationId: "conv-1" } as never;
const text = (reply: { output?: readonly { type: string; text?: string }[] }) =>
  (reply.output ?? []).map((part) => part.text ?? "").join("\n");

describe("the browser session tool (fake broker)", () => {
  it("opens, reads, snapshots with refs, and clicks by ref", async () => {
    const { tool, seen } = rig();
    const opened = await tool.execute(
      { op: "open", url: "https://example.test/page" },
      api,
      {} as never,
    );
    expect(text(opened)).toContain("A page");
    expect(seen[0]).toMatchObject({ op: "open", bot: "default", conv: "conv-1" });
    expect(
      text(await tool.execute({ op: "read", selector: "#field" }, api, {} as never)),
    ).toContain("just the field");
    expect(text(await tool.execute({ op: "snapshot" }, api, {} as never))).toContain(
      '[1] button "Go"',
    );
    await tool.execute({ op: "click", ref: 1, site: "Example.test" }, api, {} as never);
    expect(seen.find((request) => request.op === "click")).toMatchObject({
      ref: 1,
      expect_host: "example.test",
    });
    expect(browserActText({ op: "click", ref: 1 })).toBe("click element 1");
  });

  it("saves a finished download into the bot's files and names it", async () => {
    const { tool } = rig();
    const clicked = await tool.execute({ op: "click", selector: "#dl" }, api, {} as never);
    // The first test's click saved one too: a taken name gets a numbered twin.
    expect(text(clicked)).toMatch(/Downloaded report( \(\d\))?\.pdf into your files/);
    expect(listArtifacts(scratch).some((info) => info.name.startsWith("report"))).toBe(true);
  });

  it("uploads one of the bot's own files, by name", async () => {
    const { tool, seen } = rig();
    await putFile(scratch, "/note.txt", new Uint8Array(Buffer.from("hi")), {
      conversationId: "conv-1",
    });
    const done = await tool.execute({ op: "upload", file: "note.txt", ref: 3 }, api, {} as never);
    expect(done.isError).toBeUndefined();
    expect(seen.at(-1)).toMatchObject({
      op: "upload",
      name: "note.txt",
      data: Buffer.from("hi").toString("base64"),
    });
    const missing = await tool.execute({ op: "upload", file: "nope.txt" }, api, {} as never);
    expect(text(missing)).toContain('no file of yours is called "nope.txt"');
  });

  it("refuses password fields and a browser another conversation holds", async () => {
    const { tool } = rig();
    const typed = await tool.execute(
      { op: "type", selector: "input[type=password]", text: "x" },
      api,
      {} as never,
    );
    expect(text(typed)).toContain("browser_login");
    const pressed = await tool.execute({ op: "press", key: "Enter" }, api, {} as never);
    expect(text(pressed)).toContain("in use by another of your conversations");
  });

  it("saves the screenshot as an artifact and closes", async () => {
    const { tool, facility } = rig();
    await tool.execute({ op: "open", url: "https://example.test/page" }, api, {} as never);
    expect(text(await tool.execute({ op: "shot" }, api, {} as never))).toContain(
      "screenshot saved as artifact",
    );
    expect(text(await tool.execute({ op: "close" }, api, {} as never))).toContain("closed");
    expect(facility.browsers.list()).toEqual([]);
  });

  it("a takeover BLOCKS: the bot's acts are held off, finish returns the page", async () => {
    const { tool, facility, seen } = rig();
    await tool.execute({ op: "open", url: "https://example.test/page" }, api, {} as never);
    const call = tool.execute(
      { op: "takeover", reason: "the sign-in needs you" },
      api,
      {} as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rowId = facility.takeovers.list()[0]?.id ?? "";
    expect(rowId).not.toBe("");
    expect(seen.find((request) => request.op === "hold")).toMatchObject({ on: true });
    expect(text(await tool.execute({ op: "click", selector: "#go" }, api, {} as never))).toContain(
      "holds the controls",
    );
    expect(
      text(await tool.execute({ op: "open", url: "https://example.test/x" }, api, {} as never)),
    ).toContain("holds the controls");
    await facility.takeovers.finish(rowId);
    const reply = await call;
    expect(text(reply)).toContain("just the field");
    expect(reply.structuredOutput).toMatchObject({ ok: true, outcome: "finished" });
    expect(facility.life.history("x", "y")).toEqual([]);
  });

  it("step-away and the cap resolve the blocked call plainly", async () => {
    const quick = browserSessionFacility({
      root: scratch,
      backend: () => fakeBackend([]),
      takeoverMaxMs: 40,
      signins: null,
    });
    const capability = quick.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no tool");
    const timed = await capability.tool.execute(
      { op: "takeover", reason: "a code" },
      api,
      {} as never,
    );
    expect(timed.structuredOutput).toMatchObject({ outcome: "timed-out" });
    const { tool, facility } = rig();
    const call = tool.execute({ op: "takeover", reason: "a code needs you" }, api, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await facility.takeovers.cancel(facility.takeovers.list()[0]?.id ?? "");
    expect((await call).structuredOutput).toMatchObject({ outcome: "stepped-away" });
  });

  it("extends an open ask, never past the ceiling", async () => {
    const { tool, facility } = rig();
    const call = tool.execute({ op: "takeover", reason: "a code" }, api, {} as never);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const row = facility.takeovers.list()[0];
    const extended = facility.takeovers.extend(row?.id ?? "");
    expect(extended?.deadline).toBeGreaterThanOrEqual(row?.deadline ?? 0);
    expect((extended?.deadline ?? 0) - (row?.openedAt ?? 0)).toBeLessThanOrEqual(2 * 60 * 60_000);
    await facility.takeovers.cancel(row?.id ?? "");
    await call;
  });

  it("gates only the acts", () => {
    const { tool } = rig();
    const gatedWhen = (tool as { gatedWhen?: (args: unknown) => boolean }).gatedWhen;
    for (const op of ["click", "type", "press", "dialog", "upload"])
      expect(gatedWhen?.({ op })).toBe(true);
    for (const op of ["open", "read", "snapshot", "shot", "takeover", "close"])
      expect(gatedWhen?.({ op })).toBe(false);
  });

  it("a stopped turn closes its waiting ask", async () => {
    const { tool, facility } = rig();
    const stop = new AbortController();
    const call = tool.execute({ op: "takeover", reason: "sign-in" }, api, {
      abortSignal: stop.signal,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop.abort();
    expect((await call).structuredOutput).toMatchObject({ outcome: "stepped-away" });
    expect(facility.takeovers.list()).toEqual([]);
  });

  it("lists one row per bot, closes it when the task ends or it idles", async () => {
    const { tool, facility, seen } = rig({ idleMs: 40 });
    await tool.execute({ op: "open", url: "https://example.test/page" }, api, {} as never);
    expect(facility.browsers.list()).toMatchObject([
      { bot: "default", conversationId: "conv-1", title: "A page" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(facility.browsers.list()).toEqual([]);
    expect(seen.at(-1)).toMatchObject({ op: "close", force: true });
    await tool.execute({ op: "open", url: "https://example.test/page" }, api, {} as never);
    facility.life.release("conv-1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(facility.browsers.list()).toEqual([]);
  });

  it("restores saved sign-ins on a first open and saves them again on close", async () => {
    const saved: SavedSignin[] = [];
    const store: SigninStore = {
      sites: () => undefined,
      list: () => [],
      load: () => ({
        sites: ["example.test"],
        savedAt: 1,
        ua: "UA/0",
        cookies: [{ name: "a", domain: "example.test" }],
      }),
      save: (_owner, _profile, record) => void saved.push({ ...record, savedAt: 2 }),
      forget: () => true,
    };
    const seen: Request[] = [];
    const facility = browserSessionFacility({
      root: scratch,
      backend: () => fakeBackend(seen),
      signins: store,
      holder: {
        get: () => ({ scopeOf: () => ({ owner: "o", profile: "p" }) }),
      } as never,
    });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no tool");
    await capability.tool.execute(
      { op: "open", url: "https://example.test/page" },
      api,
      {} as never,
    );
    expect(seen.map((request) => request.op)).toEqual(["cookies_import", "open"]);
    expect(seen[1]).toMatchObject({ ua: "UA/0" });
    await capability.tool.execute({ op: "close" }, api, {} as never);
    expect(saved).toMatchObject([{ sites: ["example.test"], ua: "UA/1" }]);
    expect(facility.life.history("o", "p").map((row) => row.kind)).toEqual([
      "restore",
      "page",
      "close",
    ]);
    // Removing the bot: its session closes unsaved, sign-ins and history go.
    await capability.tool.execute(
      { op: "open", url: "https://example.test/page" },
      api,
      {} as never,
    );
    const before = saved.length;
    let forgot = false;
    (store as { forget: SigninStore["forget"] }).forget = () => (forgot = true);
    await facility.life.purge("o", "p");
    expect(saved.length).toBe(before);
    expect(forgot).toBe(true);
    expect(facility.browsers.list()).toEqual([]);
    expect(facility.life.history("o", "p")).toEqual([]);
  });

  it("the owner signs a bot in: page opened, controls handed over, sign-in kept on Finish", async () => {
    const saved: string[] = [];
    const store: SigninStore = {
      sites: () => undefined,
      list: () => [],
      load: () => undefined,
      save: (_owner, _profile, record) => void saved.push(record.sites.join(",")),
      forget: () => true,
    };
    const seen: Request[] = [];
    const facility = browserSessionFacility({
      root: scratch,
      backend: () =>
        fakeBackend(seen, {
          status: { ok: true, session: session({ url: "https://accounts.example.test/done" }) },
        }),
      signins: store,
      holder: { get: () => ({ scopeOf: () => ({ owner: "o", profile: "p" }) }) } as never,
    });
    const started = await facility.signInFor("conv-main", "https://accounts.example.test/", "Eve");
    expect(started).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({ op: "open", url: "https://accounts.example.test/" });
    const ask = facility.takeovers.list()[0];
    expect(ask?.reason).toBe("Sign Eve in to accounts.example.test");
    await facility.takeovers.finish(ask?.id ?? "");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(saved).toEqual(["example.test"]);
    expect(seen.at(-1)).toMatchObject({ op: "close", force: true });
    expect(facility.browsers.list()).toEqual([]);
  });

  it("refuses to sign in over a task that holds the bot's browser", async () => {
    const facility = browserSessionFacility({
      root: scratch,
      backend: () => fakeBackend([], { open: { ok: false, kind: "busy", error: "task-conv" } }),
      signins: null,
    });
    const started = await facility.signInFor("conv-main", "https://x.example/", "Eve");
    expect(started).toMatchObject({
      ok: false,
      error: expect.stringContaining("in use by one of its tasks"),
    });
    expect(facility.takeovers.list()).toEqual([]);
  });
});

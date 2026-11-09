/**
 * The browser-session tool against a FAKE backend that answers the driver
 * protocol: page facts on open, the password refusal, a screenshot artifact
 * on shot, the close handwave, the takeover round trip (the bot's acts
 * refused while the owner holds, the call blocking until the owner closes
 * it, a stopped turn closing it), the act-only gate and the session list. The
 * in-VM driver itself needs chromium; it is exercised by the opt-in real-VM
 * suite.
 */
import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShellBackend, ShellExecResult, ShellFile } from "../shell/backend.ts";
import { listArtifacts } from "./artifacts.ts";
import { browserSessionFacility, browserActText } from "./browser-session.ts";
import { DRIVER_PATH } from "../browser/driver.ts";

const scratch = mkdtempSync(join(tmpdir(), "spriessen-browser-session-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Answers driver JSON for the command embedded in the exec script. */
const fakeBackend = (): ShellBackend => ({
  prepare: async (_files: readonly ShellFile[]) => undefined,
  exec: async (script: string, _cwd: string, _timeout: number): Promise<ShellExecResult> => {
    // The install guard names the driver path first; the CALL is the last one.
    const at = script.lastIndexOf(DRIVER_PATH);
    const quoted = script.slice(at + DRIVER_PATH.length + 2);
    const command = JSON.parse(quoted.slice(0, quoted.indexOf("'"))) as { op: string };
    const replies: Record<string, unknown> = {
      open: { ok: true, url: "https://example.test/page", title: "A page", text: "page words" },
      read: { ok: true, url: "https://example.test/page", title: "A page", text: "just the field" },
      click: {
        ok: true,
        url: "https://example.test/after",
        title: "After",
        text: "clicked through",
      },
      type: { ok: false, kind: "password", error: "password fields are refused" },
      shot: { ok: true, png: PNG },
      close: { ok: true, closed: true },
    };
    return {
      stdout: `${JSON.stringify(replies[command.op] ?? { ok: false, error: "unknown op" })}\n`,
      stderr: "",
      exitCode: 0,
    };
  },
  listFiles: async () => [],
  readFile: async () => new Uint8Array(),
});

const rig = () => {
  const facility = browserSessionFacility({ root: scratch, backend: () => fakeBackend() });
  const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
  if (capability?.kind !== "tool") throw new Error("no browser_session tool");
  return { tool: capability.tool, takeovers: facility.takeovers };
};

const api = { conversationId: "conv-1" } as never;
const text = (reply: { output?: readonly { type: string; text?: string }[] }) =>
  (reply.output ?? []).map((part) => part.text ?? "").join("\n");

describe("the browser session tool (fake driver)", () => {
  it("opens a page and reports its facts; reads; clicks through", async () => {
    const { tool } = rig();
    const opened = await tool.execute(
      { op: "open", url: "https://example.test/page" },
      api,
      {} as never,
    );
    expect(text(opened)).toContain("A page");
    expect(opened.isError).toBeUndefined();
    const read = await tool.execute({ op: "read", selector: "#field" }, api, {} as never);
    expect(text(read)).toContain("just the field");
    const clicked = await tool.execute({ op: "click", selector: "#go" }, api, {} as never);
    expect(text(clicked)).toContain("clicked through");
    expect(browserActText({ op: "click", selector: "#go" })).toBe("click #go");
  });

  it("refuses password fields with the owner-actionable sentence", async () => {
    const { tool } = rig();
    const reply = await tool.execute(
      { op: "type", selector: "input[type=password]", text: "hunter2" },
      api,
      {} as never,
    );
    expect(reply.isError).toBe(true);
    expect(text(reply)).toContain("password fields are refused");
  });

  it("saves the screenshot as an artifact and closes politely", async () => {
    const { tool } = rig();
    const shot = await tool.execute({ op: "shot" }, api, {} as never);
    expect(text(shot)).toContain("screenshot saved as artifact");
    expect(listArtifacts(scratch).some((info) => info.name.startsWith("browser-"))).toBe(true);
    const closed = await tool.execute({ op: "close" }, api, {} as never);
    expect(text(closed)).toContain("closed");
  });

  it("a takeover BLOCKS: the bot's acts are held off, finish returns the page in the same call", async () => {
    const facility = browserSessionFacility({ root: scratch, backend: () => fakeBackend() });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    const tool = capability.tool;
    // The ask blocks, so it runs as a floating promise the test settles.
    const call = tool.execute(
      { op: "takeover", reason: "the sign-in needs you" },
      api,
      {} as never,
    );
    // It registers the ask promptly (the owner's list shows it).
    await new Promise((resolve) => setTimeout(resolve, 20));
    const rowId = facility.takeovers.list()[0]?.id ?? "";
    expect(rowId).not.toBe("");
    // While the owner holds: the bot's acts (and opens) are refused.
    const refused = await tool.execute({ op: "click", selector: "#go" }, api, {} as never);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("holds the controls");
    const refusedOpen = await tool.execute(
      { op: "open", url: "https://example.test/move" },
      api,
      {} as never,
    );
    expect(text(refusedOpen)).toContain("holds the controls");
    // The owner finishes: the SAME tool call returns the page as it stands.
    await facility.takeovers.finish(rowId);
    const reply = await call;
    expect(reply.isError).toBeUndefined();
    expect(text(reply)).toContain("finished");
    expect(text(reply)).toContain("just the field");
    expect(reply.structuredOutput).toMatchObject({ ok: true, outcome: "finished" });
    // The hold lifted with the close.
    const again = await tool.execute({ op: "click", selector: "#go" }, api, {} as never);
    expect(again.isError).toBeUndefined();
  });

  it("step-away resolves the blocked call plainly, without a page", async () => {
    const facility = browserSessionFacility({ root: scratch, backend: () => fakeBackend() });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    const call = capability.tool.execute(
      { op: "takeover", reason: "a code needs you" },
      api,
      {} as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await facility.takeovers.cancel(facility.takeovers.list()[0]?.id ?? "");
    const reply = await call;
    expect(reply.isError).toBeUndefined();
    expect(text(reply)).toContain("stepped away");
    expect(reply.structuredOutput).toMatchObject({ ok: true, outcome: "stepped-away" });
  });

  it("an abandoned ask closes at its cap and never pins the turn", async () => {
    const facility = browserSessionFacility({
      root: scratch,
      backend: () => fakeBackend(),
      takeoverMaxMs: 40,
    });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    const reply = await capability.tool.execute(
      { op: "takeover", reason: "the sign-in needs you" },
      api,
      {} as never,
    );
    expect(reply.isError).toBeUndefined();
    expect(text(reply)).toContain("did not take the controls");
    expect(reply.structuredOutput).toMatchObject({ ok: true, outcome: "timed-out" });
    // The hold went with the close.
    expect(facility.takeovers.list()).toEqual([]);
    expect(facility.takeovers.holds("conv-1")).toBe(false);
  });

  it("gates only the acts: reads, the ask and close run without a card", () => {
    const { tool } = rig();
    const gatedWhen = (tool as { gatedWhen?: (args: unknown) => boolean }).gatedWhen;
    expect(gatedWhen).toBeDefined();
    for (const op of ["click", "type", "press"]) expect(gatedWhen?.({ op })).toBe(true);
    for (const op of ["open", "read", "shot", "takeover", "close"]) {
      expect(gatedWhen?.({ op })).toBe(false);
    }
  });

  it("a stopped turn closes its waiting ask (no takeover left for nobody)", async () => {
    const facility = browserSessionFacility({ root: scratch, backend: () => fakeBackend() });
    const changes: string[] = [];
    facility.takeovers.listen((change) => changes.push(change.kind));
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    const stop = new AbortController();
    const call = capability.tool.execute({ op: "takeover", reason: "the sign-in needs you" }, api, {
      abortSignal: stop.signal,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The ask is announced the moment it opens — not when the call returns.
    expect(changes).toEqual(["opened"]);
    stop.abort();
    const reply = await call;
    expect(reply.structuredOutput).toMatchObject({ outcome: "stepped-away" });
    expect(facility.takeovers.list()).toEqual([]);
    expect(changes).toEqual(["opened", "closed"]);
  });

  it("lists the session while it runs and forgets it on close", async () => {
    const facility = browserSessionFacility({ root: scratch, backend: () => fakeBackend() });
    let signals = 0;
    facility.browsers.listen(() => {
      signals += 1;
    });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    await capability.tool.execute(
      { op: "open", url: "https://example.test/page" },
      api,
      {} as never,
    );
    expect(facility.browsers.list()).toMatchObject([
      { conversationId: "conv-1", url: "https://example.test/page", title: "A page" },
    ]);
    // The same page again changes nothing the list shows: no signal.
    await capability.tool.execute({ op: "read" }, api, {} as never);
    expect(signals).toBe(1);
    await capability.tool.execute({ op: "close" }, api, {} as never);
    expect(facility.browsers.list()).toEqual([]);
    expect(signals).toBe(2);
  });
});

/**
 * The browser-session tool against a FAKE backend that answers the driver
 * protocol: page facts on open, the password refusal, a screenshot artifact
 * on shot, the close handwave, and the takeover round trip (the bot's acts
 * refused while the owner holds, the owner driving, the finish wake). The
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

  it("a takeover holds the bot's acts, takes the owner's, and wakes on finish", async () => {
    const wakes: { conversationId: string; wake: string }[] = [];
    const facility = browserSessionFacility({
      root: scratch,
      backend: () => fakeBackend(),
      onTakeoverFinished: (conversationId, wake) => wakes.push({ conversationId, wake }),
    });
    const capability = facility.plugin.capabilities.find((candidate) => candidate.kind === "tool");
    if (capability?.kind !== "tool") throw new Error("no browser_session tool");
    const tool = capability.tool;
    const asked = await tool.execute(
      { op: "takeover", reason: "the sign-in needs you" },
      api,
      {} as never,
    );
    expect(text(asked)).toContain("asked to take the controls");
    // While the owner holds: the bot's acts are refused.
    const refused = await tool.execute({ op: "click", selector: "#go" }, api, {} as never);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("holds the controls");
    // The owner drives, one act at a time, and each answer carries the shot.
    const after = await facility.takeovers.act(facility.takeovers.list()[0]?.id ?? "", {
      kind: "click",
      selector: "#signin",
    });
    expect(after.ok).toBe(true);
    expect(after.png).not.toBe("");
    // Finish: the bot is woken with the page, and the hold is gone.
    const row = await facility.takeovers.finish(facility.takeovers.list()[0]?.id ?? "");
    expect(row?.conversationId).toBe("conv-1");
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.wake).toContain("takeover is finished");
    const again = await tool.execute({ op: "click", selector: "#go" }, api, {} as never);
    expect(again.isError).toBeUndefined();
  });
});

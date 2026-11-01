import { describe, expect, it, afterAll } from "vite-plus/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserPlugin } from "./browser.ts";
import { listArtifacts } from "./artifacts.ts";
import { NO_CHROMIUM_EXIT, NO_CHROMIUM_MARKER } from "../browser/command.ts";
import type { ShellBackend, ShellExecResult } from "../shell/backend.ts";

const dir = mkdtempSync(join(tmpdir(), "spriessen-browser-"));
realpathSync(dir);
const api = { conversationId: "conv-1" } as never;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const DOM =
  "<html><head><title>Local page</title></head><body><p>sandbox browser works</p></body></html>";

/** A backend that never touches a real VM: canned exec result, canned PNG. */
const fakeBackend = (
  exec: (script: string, cwd: string, timeoutMs: number) => ShellExecResult,
  readFile: (path: string) => Uint8Array = () => PNG,
): ShellBackend => ({
  prepare: async () => {},
  exec: async (script, cwd, timeoutMs) => exec(script, cwd, timeoutMs),
  listFiles: async () => [],
  readFile: async (path) => readFile(path),
});

const toolOf = (plugin: ReturnType<typeof browserPlugin>) => {
  const capability = plugin.capabilities.find(
    (candidate) => candidate.kind === "tool" && candidate.tool.name === "browser_open",
  );
  if (capability?.kind !== "tool") throw new Error("missing browser_open tool");
  return capability.tool;
};

const textOf = (result: { output?: unknown }): string => {
  const block = (result.output as { type: string; text?: string }[] | undefined)?.[0];
  return block?.text ?? "";
};

const pluginWith = (backend: ShellBackend) => browserPlugin({ root: dir, backend: () => backend });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("browser_open (read-only, one page per call)", () => {
  it("is present, NOT gated (a pure read, like web_fetch), and takes one url", () => {
    const tool = toolOf(pluginWith(fakeBackend(() => ({ stdout: DOM, stderr: "", exitCode: 0 }))));
    expect(tool.gated).toBe(false);
    const description = tool.description.toLowerCase();
    expect(description).toContain("read-only");
    expect(description).toContain("network policy");
    expect(description).toContain("no clicking");
    const params = tool.parameters as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(params.properties)).toEqual(["url"]);
    expect(params.required).toEqual(["url"]);
  });

  it("opens a page: capped text to the model, the screenshot as image + artifact", async () => {
    const seen: { script: string; cwd: string; timeoutMs: number }[] = [];
    const plugin = pluginWith(
      fakeBackend((script, cwd, timeoutMs) => {
        seen.push({ script, cwd, timeoutMs });
        return { stdout: DOM, stderr: "", exitCode: 0 };
      }),
    );
    const result = await toolOf(plugin).execute(
      { url: "http://local.test/page" },
      api,
      {} as never,
    );
    // The chromium run was bounded, aimed at the page, and screenshot-capped.
    expect(seen).toHaveLength(1);
    const call = seen[0] as { script: string; cwd: string; timeoutMs: number };
    expect(call.timeoutMs).toBe(45_000);
    expect(call.script).toContain("'http://local.test/page'");
    expect(call.script).toContain("--window-size=1280,");
    expect(call.cwd).toBe("/home");
    // The model reads the text plus a viewable image block.
    const text = textOf(result);
    expect(text).toContain("# Local page");
    expect(text).toContain("sandbox browser works");
    const blocks = result.output as { type: string }[];
    expect(blocks.some((block) => block.type === "image")).toBe(true);
    // The screenshot is an artifact the owner can open, with the details ref.
    const saved = listArtifacts(dir).find((info) => info.name.startsWith("screenshot-"));
    expect(saved?.mime).toBe("image/png");
    expect(result.structuredOutput).toMatchObject({
      url: "http://local.test/page",
      title: "Local page",
      screenshot: { id: saved?.id ?? "", name: saved?.name ?? "" },
    });
    expect((result.details as { mime: string; bytes: number }).mime).toBe("image/png");
  });

  it("refuses non-http schemes before anything runs", async () => {
    let calls = 0;
    const plugin = pluginWith(
      fakeBackend(() => {
        calls += 1;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "not a url"]) {
      const result = await toolOf(plugin).execute({ url }, api, {} as never);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Only http(s) pages");
    }
    expect(calls).toBe(0);
  });

  it("a missing chromium is an owner action (rebuild the image), never an install", async () => {
    const plugin = pluginWith(
      fakeBackend(() => ({
        stdout: `${NO_CHROMIUM_MARKER}\n`,
        stderr: "",
        exitCode: NO_CHROMIUM_EXIT,
      })),
    );
    const result = await toolOf(plugin).execute({ url: "http://local.test/" }, api, {} as never);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rebuild the sandbox image");
    expect(textOf(result)).toContain("never installs anything");
  });

  it("an unreachable page names the network policy, not a bare stack trace", async () => {
    for (const result of [
      { stdout: "", stderr: "net::ERR_CONNECTION_REFUSED", exitCode: 1 },
      {
        stdout: "",
        stderr: "ERROR:x] Page load failed: net::ERR_TUNNEL_CONNECTION_FAILED",
        exitCode: 0,
      },
    ]) {
      const plugin = pluginWith(fakeBackend(() => result));
      const refused = await toolOf(plugin).execute(
        { url: "http://off-allowlist.test/" },
        api,
        {} as never,
      );
      expect(refused.isError).toBe(true);
      const text = textOf(refused);
      expect(text).toContain("network policy");
      expect(text).toContain("allowlist");
    }
  });

  it("a page over the time bound fails without hanging the call", async () => {
    const plugin = pluginWith(
      fakeBackend(() => ({ stdout: "", stderr: "Terminated", exitCode: 124 })),
    );
    const result = await toolOf(plugin).execute({ url: "http://slow.test/" }, api, {} as never);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("took too long");
  });

  it("caps the page text and still saves the screenshot", async () => {
    const huge = `<html><body><p>${"x".repeat(50_000)}</p></body></html>`;
    const plugin = pluginWith(fakeBackend(() => ({ stdout: huge, stderr: "", exitCode: 0 })));
    const result = await toolOf(plugin).execute({ url: "http://big.test/" }, api, {} as never);
    expect(result.isError).toBeUndefined();
    const structured = result.structuredOutput as { text: string; truncated?: boolean };
    expect(structured.truncated).toBe(true);
    expect(structured.text.length).toBeLessThan(21_000);
    expect(listArtifacts(dir).some((info) => info.mime === "image/png")).toBe(true);
  });

  it("a screenshot over the model budget is noted, not attached", async () => {
    const big = new Uint8Array(2_400_000); // base64s past the 3M-char budget
    const plugin = pluginWith(
      fakeBackend(
        () => ({ stdout: DOM, stderr: "", exitCode: 0 }),
        () => big,
      ),
    );
    const result = await toolOf(plugin).execute({ url: "http://heavy.test/" }, api, {} as never);
    expect(result.isError).toBeUndefined();
    expect((result.output as { type: string }[]).some((b) => b.type === "image")).toBe(false);
    expect(textOf(result)).toContain("too large to show here");
  });

  it("a page that renders no screenshot still returns its text", async () => {
    const plugin = pluginWith(
      fakeBackend(
        () => ({ stdout: DOM, stderr: "", exitCode: 0 }),
        () => {
          throw new Error("no such file");
        },
      ),
    );
    const result = await toolOf(plugin).execute({ url: "http://plain.test/" }, api, {} as never);
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("no screenshot");
    expect(result.structuredOutput).toMatchObject({ text: "sandbox browser works" });
  });
});

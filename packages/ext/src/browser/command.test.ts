import { describe, expect, it } from "vite-plus/test";
import {
  BROWSER_TIMEOUT_MS,
  browserRunOf,
  browserScript,
  NO_CHROMIUM_EXIT,
  NO_CHROMIUM_MARKER,
  SCREENSHOT_WIDTH,
  screenshotPathOf,
  shellQuote,
  TIMEOUT_EXIT,
} from "./command.ts";

const HOME = "/home/bot-x";

describe("the in-VM chromium script (browser_open)", () => {
  it("checks chromium first, and never installs anything", () => {
    const script = browserScript("https://example.test/a", screenshotPathOf(HOME, "s1"), 45_000);
    expect(script).toContain("command -v chromium");
    expect(script).toContain(NO_CHROMIUM_MARKER);
    expect(script).toContain(`exit ${NO_CHROMIUM_EXIT}`);
    expect(script).not.toMatch(/apt|pip|npm/);
  });

  it("bounds the run with timeout so a hung renderer cannot hang the tool", () => {
    const script = browserScript("https://example.test/", screenshotPathOf(HOME, "s2"), 45_000);
    expect(script).toContain(`timeout -k 5 ${Math.ceil(BROWSER_TIMEOUT_MS / 1000)}`);
    // The exec itself is bounded by the same window.
    expect(BROWSER_TIMEOUT_MS).toBe(45_000);
  });

  it("runs headless with the slice-1-proven flags and a capped window", () => {
    const script = browserScript("https://example.test/", screenshotPathOf(HOME, "s3"), 45_000);
    expect(script).toContain("--headless");
    expect(script).toContain("--no-sandbox");
    expect(script).toContain("--disable-gpu");
    expect(script).toContain("--disable-dev-shm-usage");
    expect(script).toContain(`--window-size=${SCREENSHOT_WIDTH},`);
    expect(SCREENSHOT_WIDTH).toBeLessThanOrEqual(1280);
  });

  it("asks one run for both the DOM and the screenshot, and quotes its inputs", () => {
    const shot = screenshotPathOf(HOME, "s4");
    const script = browserScript("https://example.test/a b?x=1", shot, 45_000);
    expect(script).toContain("--dump-dom");
    expect(script).toContain(`--screenshot=${shellQuote(shot)}`);
    expect(script).toContain(`'https://example.test/a b?x=1'`);
    expect(shot).toBe(`${HOME}/.tmp/screenshot-s4.png`);
    // The screenshot lands in the bot's own .tmp, never a shared folder.
    expect(shot.startsWith(`${HOME}/.tmp/`)).toBe(true);
  });

  it("reads the run: ok, missing browser, timeout, and failure", () => {
    expect(browserRunOf({ stdout: "<html></html>", stderr: "", exitCode: 0 })).toEqual({
      kind: "ok",
    });
    expect(
      browserRunOf({ stdout: `${NO_CHROMIUM_MARKER}\n`, stderr: "", exitCode: NO_CHROMIUM_EXIT }),
    ).toEqual({ kind: "no-chromium" });
    expect(browserRunOf({ stdout: "", stderr: "Terminated", exitCode: TIMEOUT_EXIT })).toEqual({
      kind: "failed",
      detail: "the page took too long to load",
    });
    const failed = browserRunOf({
      stdout: "",
      stderr: "net::ERR_CONNECTION_REFUSED\n",
      exitCode: 1,
    });
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") expect(failed.detail).toContain("ERR_CONNECTION_REFUSED");
  });

  it("reads the network's refusal: a blocked host exits 0 with an empty DOM", () => {
    // Probe-verified shape: the policy refusal surfaces as stderr noise, not rc.
    expect(
      browserRunOf({
        stdout: "",
        stderr:
          "ssl noise\nERROR:headless_command_handler.cc:403] Page load failed: net::ERR_CERT_AUTHORITY_INVALID\n",
        exitCode: 0,
      }),
    ).toEqual({
      kind: "failed",
      detail: "the page did not load (net::ERR_CERT_AUTHORITY_INVALID)",
    });
    // An empty stdout with no marker is still a failed load, never a blank page.
    expect(browserRunOf({ stdout: "", stderr: "", exitCode: 0 })).toEqual({
      kind: "failed",
      detail: "the page did not load",
    });
    // Noise about handshakes on a WORKING page does not fail it.
    expect(
      browserRunOf({
        stdout: "<html><body>fine</body></html>",
        stderr: "ssl_client_socket_impl.cc:949] handshake failed\n",
        exitCode: 0,
      }),
    ).toEqual({ kind: "ok" });
  });
});

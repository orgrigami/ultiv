/**
 * The chromium run inside the bot's home VM (phase 4 slice 9) — pure
 * construction and result shaping, no I/O, so the suite tests it directly.
 * The script: checks chromium is present FIRST (a missing browser is an
 * owner action — rebuild the image once, `packages/ext/sandbox/Dockerfile` —
 * never an apt install at call time), bounds the run with coreutils
 * `timeout` so a hung renderer cannot hang the tool, and asks ONE headless
 * run for both the rendered DOM (stdout, `--dump-dom`) and a PNG screenshot
 * (`--screenshot`, capped at the window size). Flags are the set slice 1's
 * capacity check proved runs in the 1-CPU/512-MiB VM.
 */
import type { ShellExecResult } from "../shell/backend.ts";

/** Whole-call bound for the chromium run; the exec timeout is the same. */
export const BROWSER_TIMEOUT_MS = 45_000;
/** Screenshot size cap: 1280 px wide (the brief's cap), a 1600 px viewport. */
export const SCREENSHOT_WIDTH = 1280;
export const SCREENSHOT_HEIGHT = 1600;
/** Stdout marker + exit code when the VM image has no chromium. */
export const NO_CHROMIUM_MARKER = "__SPRIESSEN_NO_CHROMIUM__";
export const NO_CHROMIUM_EXIT = 90;
/** coreutils `timeout` kills the child with 124 when the bound is hit. */
export const TIMEOUT_EXIT = 124;

/** Single-quote a value for `bash -c` (the only quoting bash honors). */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Where the PNG lands: the bot's own `.tmp` (mode-700 home, umask 0600). */
export const screenshotPathOf = (home: string, stamp: string): string =>
  `${home}/.tmp/screenshot-${stamp}.png`;

/** The in-VM script for one page: presence check, bounded headless run. */
export const browserScript = (url: string, shotPath: string, timeoutMs: number): string => {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return [
    `if ! command -v chromium >/dev/null 2>&1; then`,
    `  echo ${shellQuote(NO_CHROMIUM_MARKER)}; exit ${NO_CHROMIUM_EXIT}; fi`,
    `mkdir -p ${shellQuote(shotPath.replace(/\/[^/]*$/, ""))}`,
    `timeout -k 5 ${seconds} chromium \\`,
    `  --headless --no-sandbox --disable-gpu --disable-dev-shm-usage \\`,
    `  --hide-scrollbars --disable-extensions \\`,
    `  --window-size=${SCREENSHOT_WIDTH},${SCREENSHOT_HEIGHT} \\`,
    `  --virtual-time-budget=8000 \\`,
    `  --dump-dom --screenshot=${shellQuote(shotPath)} \\`,
    `  ${shellQuote(url)}`,
  ].join("\n");
};

/** What one exec result says about the chromium run. */
export type BrowserRun =
  | { readonly kind: "ok" }
  | { readonly kind: "no-chromium" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed"; readonly detail: string };

export const browserRunOf = (result: ShellExecResult): BrowserRun => {
  if (result.stdout.includes(NO_CHROMIUM_MARKER)) return { kind: "no-chromium" };
  // A policy-blocked host does NOT fail the process: chromium exits 0 with an
  // empty DOM and the refusal on stderr ("Page load failed: net::ERR_…"),
  // so the refusal is read from there (probe-verified on this host).
  const loadFailure = /Page load failed: (net::[A-Z0-9_]+)/.exec(result.stderr)?.[1];
  if (result.exitCode !== 0) {
    if (result.exitCode === TIMEOUT_EXIT)
      return { kind: "failed", detail: "the page took too long to load" };
    const detail = result.stderr.trim().split("\n").slice(-3).join("; ").slice(0, 300);
    return {
      kind: "failed",
      detail: detail === "" ? `chromium exited ${result.exitCode}` : detail,
    };
  }
  if (loadFailure !== undefined)
    return { kind: "failed", detail: `the page did not load (${loadFailure})` };
  if (result.stdout.trim() === "") return { kind: "failed", detail: "the page did not load" };
  return { kind: "ok" };
};

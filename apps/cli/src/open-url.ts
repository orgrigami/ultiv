/**
 * Open a URL in this machine's browser, when it has one: `open` on macOS,
 * `start` on Windows, `wslview` under WSL, else `xdg-open`. Over SSH the
 * browser would open on the wrong machine, so nothing opens there. Answers
 * whether a browser was asked; callers always show the URL too.
 */
import { spawn, spawnSync } from "node:child_process";

const opener = (): { command: string; args: string[] } | undefined => {
  if (process.platform === "darwin") return { command: "open", args: [] };
  if (process.platform === "win32") return { command: "cmd", args: ["/c", "start", ""] };
  const found = (name: string) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
  if (found("wslview")) return { command: "wslview", args: [] };
  if (found("xdg-open")) return { command: "xdg-open", args: [] };
  return undefined;
};

export const openUrl = (url: string): boolean => {
  const program = opener();
  if (program === undefined || process.env["SSH_CONNECTION"] !== undefined) return false;
  const child = spawn(program.command, [...program.args, url], { stdio: "ignore", detached: true });
  child.on("error", () => undefined);
  child.unref();
  return true;
};

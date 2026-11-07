/**
 * Small set-up commands: `open` (the web app, or one chat, in the
 * browser — the URL is always printed too, for a machine without one),
 * `completion` (bash/zsh/fish from the command table) and `version` (the
 * CLI's version, the checkout's commit, the Node it runs on).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Parsed } from "../args.ts";
import { openUrl } from "../open-url.ts";
import { bashCompletion, fishCompletion, zshCompletion } from "../completion.ts";
import { apiFor, findChat } from "./context.ts";
import { repoRoot } from "./serve.ts";

export const open = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const wanted = parsed.positionals[1];
  const url =
    wanted !== undefined ? `${api.server}/c/${(await findChat(api, wanted)).id}` : `${api.server}/`;
  console.log(url);
  openUrl(url);
};

export const completion = async (parsed: Parsed): Promise<number> => {
  const shell = parsed.positionals[1] ?? process.env["SHELL"]?.split("/").at(-1);
  const script =
    shell === "bash"
      ? bashCompletion()
      : shell === "zsh"
        ? zshCompletion()
        : shell === "fish"
          ? fishCompletion()
          : undefined;
  if (script === undefined) {
    console.error("usage: spriessen completion <bash|zsh|fish>");
    return 1;
  }
  process.stdout.write(script);
  return 0;
};

export const version = async (): Promise<void> => {
  const root = repoRoot();
  const manifest = join(root, "apps", "cli", "package.json");
  const cli = existsSync(manifest)
    ? (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version
    : undefined;
  const git = spawnSync("git", ["-C", root, "log", "-1", "--format=%h %cs"], { encoding: "utf8" });
  const commit = git.status === 0 ? git.stdout.trim() : undefined;
  console.log(`spriessen ${cli ?? "?"}${commit !== undefined ? ` (${commit})` : ""}`);
  console.log(`node ${process.versions.node} · source ${root}`);
};

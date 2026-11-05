/**
 * Open the terminal UI for a signed-in client (main.ts checks the sign-in
 * BEFORE this module loads: loading OpenTUI already talks to the terminal,
 * and a failure must read as a plain sentence), then hand the terminal to
 * OpenTUI until ctrl-c. The renderer is destroyed — never `process.exit` — so the
 * terminal always gets its normal screen, cursor and line mode back.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { stringFlag, type Parsed } from "../args.ts";
import type { Api } from "../client/http.ts";
import { connectLive } from "../client/live.ts";
import { App } from "./app.tsx";

export const runTui = async (api: Api & { cookie: string }, parsed: Parsed): Promise<void> => {
  const live = connectLive(api.server, api.cookie);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const closed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  createRoot(renderer).render(<App api={api} live={live} wanted={stringFlag(parsed, "bot")} />);
  await closed;
  live.close();
};

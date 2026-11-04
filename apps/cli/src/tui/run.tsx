/**
 * Open the terminal UI: check the sign-in first (a plain sentence, not a
 * broken screen, when it is missing), then hand the terminal to OpenTUI
 * until ctrl-c. The renderer is destroyed — never `process.exit` — so the
 * terminal always gets its normal screen, cursor and line mode back.
 */
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { stringFlag, type Parsed } from "../args.ts";
import { connectLive } from "../client/live.ts";
import { apiFor } from "../commands/context.ts";
import { App } from "./app.tsx";

export const runTui = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const status = await api.authStatus().catch(() => undefined);
  if (status === undefined)
    throw new Error(`cannot reach ${api.server} (start one: spriessen serve)`);
  if (api.cookie === undefined || !status.session) {
    throw new Error(`not signed in to ${api.server}: run \`spriessen login\``);
  }
  const live = connectLive(api.server, api.cookie);
  const renderer = await createCliRenderer({ exitOnCtrlC: false });
  const closed = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  createRoot(renderer).render(<App api={api} live={live} wanted={stringFlag(parsed, "bot")} />);
  await closed;
  live.close();
};

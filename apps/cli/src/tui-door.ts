/**
 * The way into the terminal UI. Plain TS: it checks the terminal and the
 * sign-in, and resolves `--chat`, BEFORE OpenTUI loads — loading OpenTUI
 * already talks to the terminal, and a failure must read as a plain
 * sentence. The UI itself is TSX: it loads through the build (dist) or
 * `vpx`, never plain `node` on the source.
 */
import { stringFlag, type Parsed } from "./args.ts";
import { SignInRequired } from "./client/http.ts";
import { apiFor, findChat } from "./commands/context.ts";

export const openTui = async (parsed: Parsed): Promise<number> => {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(
      'The terminal UI needs a terminal. Try `spriessen ask "…"` or `spriessen --help`.',
    );
    return 1;
  }
  const api = apiFor(parsed);
  const status = await api.authStatus();
  if (api.cookie === undefined || !status.session) throw new SignInRequired();
  const chatFlag = stringFlag(parsed, "chat");
  const chat = chatFlag !== undefined ? await findChat(api, chatFlag) : undefined;
  let tui: typeof import("./tui/run.tsx");
  try {
    tui = await import("./tui/run.tsx");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_FILE_EXTENSION") throw cause;
    console.error("The terminal UI needs the build first: run `vp -C apps/cli build`.");
    return 1;
  }
  await tui.runTui(
    { ...api, cookie: api.cookie },
    {
      bot: chat?.profile ?? stringFlag(parsed, "bot"),
      chat: chat?.id,
    },
  );
  return 0;
};

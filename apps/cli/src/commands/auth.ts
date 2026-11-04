/**
 * `spriessen login | logout | status`. Login is the web's own passcode
 * sign-in: the passcode goes to `/api/auth/sign-in` (or, on a fresh install
 * run on the host itself, sets the first passcode), the session cookie that
 * comes back is saved 0600 in the config folder, and the passcode itself is
 * never stored. The prompt reads without echo on a terminal; piped input
 * (`printf %s "$PASS" | spriessen login`) works for scripts.
 */
import { stringFlag, type Parsed } from "../args.ts";
import { createApi } from "../client/http.ts";
import { forgetCredentials, readCredentials, saveCredentials, serverOf } from "../config.ts";
import { apiFor } from "./context.ts";

/** Read one line without echo (a TTY), or the first line of piped input. */
export const promptHidden = async (question: string): Promise<string> => {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = "";
    for await (const chunk of input) {
      text += String(chunk);
      if (text.includes("\n")) break;
    }
    return text.split("\n")[0]?.replace(/\r$/, "") ?? "";
  }
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  return new Promise<string>((resolve, reject) => {
    let text = "";
    const done = (finish: () => void): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stderr.write("\n");
      finish();
    };
    const onData = (chunk: Buffer): void => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") return done(() => resolve(text));
        if (char === "\u0003") return done(() => reject(new Error("cancelled")));
        if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
        else if (char >= " ") text += char;
      }
    };
    input.on("data", onData);
  });
};

export const login = async (parsed: Parsed): Promise<void> => {
  const server = serverOf(stringFlag(parsed, "server"));
  const api = createApi(server, undefined);
  const status = await api.authStatus();
  let cookie: string;
  if (!status.passcodeSet) {
    if (!status.bootstrap) {
      throw new Error("this server has no passcode yet; set it on the host itself first");
    }
    const passcode = await promptHidden("Choose a passcode for this server (8+ characters): ");
    cookie = await api.setPasscode(passcode);
  } else {
    const passcode = await promptHidden(`Passcode for ${server}: `);
    cookie = await api.signIn(passcode);
  }
  saveCredentials({ server, cookie, savedAt: Date.now() });
  console.log(`Signed in to ${server}.`);
};

export const logout = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  if (api.cookie !== undefined) await api.signOut().catch(() => undefined);
  console.log(forgetCredentials() ? "Signed out." : "Not signed in.");
};

export const status = async (parsed: Parsed): Promise<void> => {
  const api = apiFor(parsed);
  const saved = readCredentials();
  let line: string;
  try {
    const state = await api.authStatus();
    line =
      api.cookie !== undefined && state.session
        ? `Signed in to ${api.server}.`
        : state.passcodeSet
          ? `Not signed in to ${api.server}. Run: spriessen login`
          : `${api.server} has no passcode yet. Run on the host: spriessen login`;
  } catch {
    line = `Cannot reach ${api.server}.${saved === undefined ? "" : ` (saved: ${saved.server})`}`;
  }
  console.log(line);
};

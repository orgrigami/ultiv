/**
 * Where the agent finds its pairing token, best first:
 *   1. a token FILE (`--token-file` / `SPRIESSEN_NODE_TOKEN_FILE`) — the
 *      recommended form: nothing on the command line, nothing in `env`;
 *   2. `SPRIESSEN_NODE_TOKEN`;
 *   3. `--token` — still accepted, but any process of the same account can
 *      read a command line (`ps`), so it earns a warning.
 * The env keys are removed from the agent's own `process.env` once read, and
 * scripts never inherit them (run-script.ts). A token file readable by other
 * accounts is refused.
 */
import { readFileSync, statSync } from "node:fs";

export interface TokenSource {
  readonly token?: string | undefined;
  readonly tokenFile?: string | undefined;
}

export interface ResolvedToken {
  readonly token: string;
  /** A sentence for the log when the source is weaker than a file. */
  readonly warning?: string;
}

export const readTokenFile = (path: string): string => {
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`the token file ${path} is readable by other accounts; run: chmod 600 ${path}`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token === "") throw new Error(`the token file ${path} is empty`);
  return token;
};

export const resolveToken = (
  flags: TokenSource,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedToken | undefined => {
  const file = flags.tokenFile ?? env["SPRIESSEN_NODE_TOKEN_FILE"];
  const fromEnv = env["SPRIESSEN_NODE_TOKEN"];
  delete env["SPRIESSEN_NODE_TOKEN"];
  delete env["SPRIESSEN_NODE_TOKEN_FILE"];
  if (file !== undefined && file !== "") return { token: readTokenFile(file) };
  if (fromEnv !== undefined && fromEnv !== "") return { token: fromEnv };
  if (flags.token !== undefined && flags.token !== "") {
    return {
      token: flags.token,
      warning:
        "agent: --token is visible to every process of this account (ps); " +
        "prefer --token-file <path> (chmod 600)",
    };
  }
  return undefined;
};

/** The node agent as a library: the `spriessen node` command runs the same dial. */
export { agentUrlOf, confine, connectAgent } from "./agent.ts";
export type { AgentHandle, AgentOptions } from "./agent.ts";
export { resolveToken, readTokenFile } from "./token.ts";
export type { ResolvedToken, TokenSource } from "./token.ts";
export { runScript, scriptEnv, scrub } from "./run-script.ts";
export { createExecs } from "./execs.ts";
export type { RunningScript, ScriptResult } from "./run-script.ts";

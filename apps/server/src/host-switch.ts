/**
 * The host-access switch at DECIDE time (slice 10). A queued host-direct
 * call — `bash_host`, or a stdio connector's tool (its server runs as a host
 * process) — is refused when the bot's effective host access went false
 * after the card was parked: turning the org or team off acts at once,
 * on calls already waiting (F6). Both decide paths (the chat card in
 * `session-methods.ts` and the inbox in `rest/approvals.ts`) ask here; the
 * request-time gates (the act's guard, the connector call gate) already
 * check the same effective flag BEFORE any approval, so a stored allow rule
 * only ever applies once the switch passes.
 */
import {
  isHostDirectServer,
  isBeyondVmCall,
  switchAllows,
  type MindService,
} from "@spriessen/mind";

/** The note a refused approval carries back to the tool (and the audit row). */
export const HOST_SWITCH_NOTE =
  "refused by the host-access switch: this bot's host access is off, so the call does not run even approved";

/**
 * True when the waiting call runs beyond the VM: `bash` with `target:
 * "host"` / `target: "node"` (the merged tool; the input decides), or a tool
 * of a stdio server (tool names are unique per server slug, so one view
 * matches).
 */
export const isHostDirectCall = (mind: MindService, name: string, input?: unknown): boolean => {
  if (isBeyondVmCall(name, input)) return true;
  return mind.mcp
    .views()
    .some((view) => isHostDirectServer(view) && view.tools.some((tool) => tool.name === name));
};

/**
 * The refusal for approving a waiting host-direct call, or null when the
 * approval may stand: the call is not host-direct, or the bot's effective
 * switch (org AND team AND bot) is on. Fail-closed like the per-call
 * guard: a host-direct call whose conversation maps to no bot, or whose
 * org view cannot be read, is refused.
 */
export const hostSwitchRefusal = async (
  mind: MindService,
  conversationId: string,
  name: string,
  input?: unknown,
): Promise<string | null> => {
  if (!isHostDirectCall(mind, name, input)) return null;
  const profile = mind.profiles.profileOf(conversationId);
  if (profile === undefined) return HOST_SWITCH_NOTE;
  const view = await mind.org.view().catch(() => undefined);
  if (switchAllows(view, profile)) return null;
  return HOST_SWITCH_NOTE;
};

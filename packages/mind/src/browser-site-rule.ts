/**
 * Per-site approvals for the bot's browser: the autoApprove entry
 * `browser_session@site:<host>` approves a `browser_session` ACT (click,
 * type, press, dialog — never an upload, never a vault login) whose `site`
 * is exactly that host. The model names the site; the BROWSER BROKER refuses
 * the act unless the page really is on it (the act carries `expect_host`),
 * so a rule for one site can never approve an act on another. "Always
 * allow" on a browser card saves this rule — or nothing when the act names
 * no site — instead of a whole-tool grant.
 */

export const BROWSER_SESSION_TOOL = "browser_session";
export const BROWSER_SITE_PREFIX = "browser_session@site:";

/** The acts a site rule may approve. */
const SITE_OPS: ReadonlySet<unknown> = new Set(["click", "type", "press", "dialog"]);

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** The site rule for a host, or undefined when it is not a plain host[:port]. */
export const siteRuleEntry = (site: unknown): string | undefined => {
  if (typeof site !== "string") return undefined;
  const host = site.trim().toLowerCase();
  return HOST.test(host) ? `${BROWSER_SITE_PREFIX}${host}` : undefined;
};

export const isSiteRule = (entry: string): boolean => entry.startsWith(BROWSER_SITE_PREFIX);

/** The site rule this call could be approved by (an act that names its site), if any. */
export const siteRuleOf = (name: string, input: unknown): string | undefined => {
  if (name !== BROWSER_SESSION_TOOL || input === null || typeof input !== "object")
    return undefined;
  const call = input as { readonly op?: unknown; readonly site?: unknown };
  return SITE_OPS.has(call.op) ? siteRuleEntry(call.site) : undefined;
};

/** True when a stored site rule approves this call. */
export const siteRuleMatches = (entry: string, name: string, input: unknown): boolean =>
  isSiteRule(entry) && siteRuleOf(name, input) === entry;

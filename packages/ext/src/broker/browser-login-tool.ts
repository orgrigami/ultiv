/**
 * `browser_login`: the credential broker's BROWSER adapter. The bot names a
 * vault LOGIN; the server opens it after every policy check (visibility to
 * the bot and its home, a `browser` binding, allowed bots) and has the
 * home VM's browser broker fill it into the bot's own page — username,
 * password and, when the item holds a TOTP secret, the current code. The
 * model never sees any of it. The page must be on one of the binding's
 * hosts, as the BROWSER reports it (never the model's claim), and the host
 * the owner approved is the host it fills on: the broker checks both at the
 * moment it types. A login's first use on a host waits for the owner's card
 * (per-profile auto-approve never covers it); after that it fills straight
 * through. Every fill — and every refusal — writes a `credential` audit row
 * without a secret byte. A fill marks the site signed in, so the session's
 * cookies are kept for the bot's next session.
 */
import { obj, str } from "@earendil-works/pi-schema";
import type { AuditEvent, VaultItemInfo } from "@spriessen/contracts";
import { defineTool, type Tool } from "../tool.ts";
import { findCredential, type BrokerScope } from "./credential.ts";
import type { BrokerDeps } from "./http-request-tool.ts";
import { totpCode } from "./totp.ts";

export const BROWSER_LOGIN_TOOL = "browser_login";
/** A distinct card name: per-profile auto-approve never covers a credential's first use. */
export const BROWSER_FIRST_USE_APPROVAL = "browser_login (first use of a credential)";

/** What the browser facility gives the adapter: the page's address, and the fill. */
export interface BrowserFillDeps {
  readonly pageUrl: (conversationId: string) => Promise<string | undefined>;
  readonly fill: (
    conversationId: string,
    request: {
      readonly hosts: readonly string[];
      readonly expect_host: string;
      readonly username: string;
      readonly password: string;
      readonly otp?: string;
    },
  ) => Promise<{ ok?: boolean; kind?: string; error?: string; filled?: unknown }>;
  readonly signedIn: (conversationId: string, host: string) => void;
}

const fail = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

const audit = (
  deps: BrokerDeps,
  base: { conversationId: string; callId: string; scope: BrokerScope | undefined },
  item: VaultItemInfo | null,
  host: string,
  startedAt: number,
  error: string | null,
): void => {
  const event: AuditEvent = {
    conversationId: base.conversationId,
    profile: base.scope?.profile ?? null,
    callId: base.callId,
    at: startedAt,
    kind: "credential",
    name: BROWSER_LOGIN_TOOL,
    durationMs: Date.now() - startedAt,
    ok: error === null,
    error,
    credential: {
      item: item?.name ?? null,
      adapter: "browser",
      host,
      method: "fill",
      status: null,
    },
  };
  deps.hooks.get()?.audit(event);
};

type Login = { readonly username: string; readonly password: string; readonly otp?: string };

/** The login's fields, opened only after every policy check. */
const loginOf = (deps: BrokerDeps, scope: BrokerScope, item: VaultItemInfo): Login | string => {
  let secret;
  try {
    secret = deps.vault?.resolve(scope.owner, item.id);
  } catch {
    return `"${item.name}" could not be opened (the vault key may have changed)`;
  }
  if (secret?.kind !== "login") return `"${item.name}" is not a login`;
  const otp = secret.totp === null ? undefined : totpCode(secret.totp);
  return {
    username: secret.username,
    password: secret.password,
    ...(otp !== undefined ? { otp } : {}),
  };
};

const scopeOf = (deps: BrokerDeps, conversationId: string): BrokerScope | undefined => {
  const scope = deps.holder.get()?.scopeOf(conversationId);
  const home = deps.holder.get()?.homeOf?.(conversationId);
  if (scope === undefined || scope.profile === null) return undefined;
  return { owner: scope.owner, profile: scope.profile, ...(home !== undefined ? { home } : {}) };
};

export const browserLoginTool = (deps: BrokerDeps, browser: BrowserFillDeps): Tool =>
  defineTool({
    name: BROWSER_LOGIN_TOOL,
    description:
      "Sign in on the page your browser_session is on, with a vault login (a name from " +
      "vault_list): the broker fills the username, the password and any one-time code into the " +
      "page's sign-in fields — you never see them. Only on the sites the login is bound to (as " +
      "your browser reports the page, not as you say), and its first use on a site waits for " +
      "your owner. It fills; submit the form yourself (op click or press Enter). Multi-step " +
      "sign-ins (email, then password) take one call per step. Passkeys, phone prompts and " +
      "CAPTCHAs need your owner: op takeover.",
    parameters: obj(
      { credential: str({ description: "The vault login's name or id." }) },
      { open: true },
    ),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const context = {
        conversationId,
        callId: String(api.callId),
        scope: scopeOf(deps, conversationId),
      };
      const startedAt = Date.now();
      if (deps.vault === null || deps.bindings === null) return fail("the vault is not configured");
      if (context.scope === undefined)
        return fail("logins are only available inside a bot's conversation");
      const url = await browser.pageUrl(conversationId);
      let host = "";
      try {
        host = url === undefined ? "" : new URL(url).host;
      } catch {
        host = "";
      }
      if (host === "")
        return fail(
          "no page is open in your browser: browser_session op open the sign-in page first.",
        );
      const found = findCredential(
        deps.vault,
        deps.bindings,
        context.scope,
        args.credential,
        "browser",
      );
      if (!found.ok) {
        audit(deps, context, null, host, startedAt, found.reason);
        return fail(found.reason);
      }
      const login = loginOf(deps, context.scope, found.item);
      if (typeof login === "string") return fail(login);
      if (!found.binding.approvedHosts.includes(host)) {
        const hooks = deps.hooks.get();
        const approved =
          hooks !== undefined &&
          (await hooks.confirm(conversationId, context.callId, {
            callId: context.callId,
            name: BROWSER_FIRST_USE_APPROVAL,
            input: { host, credential: found.item.name },
          }));
        if (!approved) {
          const note = hooks?.noteFor(conversationId, context.callId);
          return fail(
            note ??
              "not approved (denied, stopped, or no answer in time); do not retry; tell your owner",
          );
        }
        deps.bindings.approveHost(context.scope.owner, found.item.id, host);
      }
      const reply = await browser.fill(conversationId, {
        hosts: found.binding.hosts,
        expect_host: host,
        username: login.username,
        password: login.password,
        ...(login.otp !== undefined ? { otp: login.otp } : {}),
      });
      if (reply.ok !== true) {
        const reason =
          reply.kind === "host" || reply.kind === "site"
            ? `"${found.item.name}" may not be used on this page (its address is not one of the login's sites).`
            : (reply.error ?? "the login could not be filled");
        audit(deps, context, found.item, host, startedAt, reason);
        return fail(reason);
      }
      const filled = Array.isArray(reply.filled) ? (reply.filled as string[]) : [];
      audit(deps, context, found.item, host, startedAt, null);
      if (filled.length === 0)
        return fail(
          "no sign-in field was found on this page: take a snapshot and check where the form is.",
        );
      browser.signedIn(conversationId, host);
      return {
        output: [
          {
            type: "text",
            text: `filled ${filled.join(" and ")} from "${found.item.name}" on ${host}. Submit the form next.`,
          },
        ],
        structuredOutput: { ok: true, filled, host },
      };
    },
  });

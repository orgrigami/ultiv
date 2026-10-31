/**
 * `http_request`: the model's one HTTP egress, with or without a named vault
 * credential ("call a webhook" is just a POST through it). The model never
 * sees the secret: the broker opens it server-side after every policy check,
 * places it per the binding, and scrubs the secret (and its encodings) from
 * the result, the echoed URL and any error. Non-GET calls and a credential's
 * first use on a host wait for an approval card (the usual 120s auto-deny).
 */
import { Type } from "typebox";
import type { AuditEvent, VaultItemInfo } from "@spreissen/contracts";
import type { ScopeHolder } from "../plugins/vault.ts";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import type { VaultStore } from "../vault.ts";
import type { BindingStore } from "./bindings.ts";
import { findCredential, materialOf, MIN_SECRET_LENGTH } from "./credential.ts";
import type { BrokerHooksHolder } from "./hooks.ts";
import {
  checkHttp,
  performHttp,
  targetProblem,
  type HttpCall,
  type Transport,
} from "./http-adapter.ts";
import { makeRedactor, materialForms, type SecretMaterial } from "./redact.ts";

export const HTTP_REQUEST_TOOL = "http_request";
/** A distinct card name: per-profile auto-approve never covers a credential's first use. */
export const FIRST_USE_APPROVAL = "http_request (first use of a credential)";
/** Model-facing body cap (the transport already caps the bytes read). */
const BODY_CHARS = 60_000;

export interface BrokerDeps {
  readonly vault: VaultStore | null;
  readonly bindings: BindingStore | null;
  readonly holder: ScopeHolder;
  readonly hooks: BrokerHooksHolder;
  readonly transport?: Transport;
}

const Parameters = Type.Object({
  method: Type.Union(
    ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map((m) => Type.Literal(m)),
    { description: "HTTP method. Anything but GET/HEAD asks your owner first." },
  ),
  url: Type.String({ description: "Absolute https URL (never put secrets in it)." }),
  credential: Type.Optional(
    Type.String({
      description:
        "Name or id of a vault credential to authenticate with; the broker adds it, you never see it.",
    }),
  ),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String({ description: "Request body (JSON as a string)." })),
});

const fail = (text: string) => ({ isError: true, output: [{ type: "text" as const, text }] });

interface Spend {
  readonly item: VaultItemInfo;
  readonly material: SecretMaterial;
  readonly binding: NonNullable<ReturnType<BindingStore["get"]>>;
}

/** Policy, then the secret: returns what to spend or why not. */
const prepare = (
  deps: BrokerDeps,
  scope: { readonly owner: string; readonly profile: string } | undefined,
  call: HttpCall,
  reference: string,
): Spend | string => {
  if (deps.vault === null || deps.bindings === null) return "the vault is not configured";
  if (scope === undefined) return "credentials are only available inside a bot's conversation";
  const found = findCredential(deps.vault, deps.bindings, scope, reference);
  if (!found.ok) return found.reason;
  const check = checkHttp(found.binding, call);
  if (!check.ok) return check.reason;
  const problem = targetProblem(new URL(call.url), found.binding.allowLocalhostHttp);
  if (problem !== undefined) return problem;
  let material: SecretMaterial | undefined;
  try {
    material = materialOf(deps.vault.resolve(scope.owner, found.item.id));
  } catch {
    return `"${found.item.name}" could not be opened (the vault key may have changed)`;
  }
  if (material === undefined) return `"${found.item.name}" is not a key, login or secret note`;
  if (material.secret.length < MIN_SECRET_LENGTH)
    return `"${found.item.name}" is too short to use safely`;
  return { item: found.item, material, binding: found.binding };
};

/** Which card (if any) this call needs. */
const cardFor = (call: HttpCall, spend: Spend | null): string | undefined => {
  const host = new URL(call.url).host;
  if (spend !== null && !spend.binding.approvedHosts.includes(host)) return FIRST_USE_APPROVAL;
  return call.method === "GET" || call.method === "HEAD" ? undefined : HTTP_REQUEST_TOOL;
};

const auditEvent = (
  base: Pick<AuditEvent, "conversationId" | "profile" | "callId">,
  call: HttpCall,
  item: VaultItemInfo | null,
  startedAt: number,
  outcome: { readonly status: number | null; readonly error: string | null },
): AuditEvent => ({
  ...base,
  at: startedAt,
  kind: "credential",
  name: HTTP_REQUEST_TOOL,
  durationMs: Date.now() - startedAt,
  ok: outcome.error === null && outcome.status !== null && outcome.status < 400,
  error: outcome.error,
  credential: {
    item: item?.name ?? null,
    adapter: "http",
    host: new URL(call.url).host,
    method: call.method,
    status: outcome.status,
  },
});

export const httpRequestTool = (deps: BrokerDeps): Tool =>
  defineTool({
    name: HTTP_REQUEST_TOOL,
    description:
      "Make one HTTPS request (APIs, webhooks). Pass `credential` (a vault item name from " +
      "vault_list) to authenticate: the broker adds the secret server-side and you never see " +
      "it. Private/internal addresses are refused. Non-GET calls, and a credential's first use " +
      "on a host, wait for your owner's approval.",
    parameters: Parameters,
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const scope = deps.holder.get()?.scopeOf(conversationId);
      const call: HttpCall = {
        method: args.method,
        url: args.url,
        ...(args.headers !== undefined ? { headers: args.headers } : {}),
        ...(args.body !== undefined ? { body: args.body } : {}),
      };
      return runCall(deps, { conversationId, callId: api.callId, scope }, call, args.credential);
    },
  });

/** The call itself: preflight, card, spend, scrub, audit. */
const runCall = async (
  deps: BrokerDeps,
  context: {
    readonly conversationId: string;
    readonly callId: string;
    readonly scope: { readonly owner: string; readonly profile: string } | undefined;
  },
  call: HttpCall,
  reference: string | undefined,
) => {
  let url: URL;
  try {
    url = new URL(call.url);
  } catch {
    return fail("not an absolute URL");
  }
  const spend = reference === undefined ? null : prepare(deps, context.scope, call, reference);
  if (typeof spend === "string") return fail(spend);
  const problem = targetProblem(url, spend?.binding.allowLocalhostHttp ?? false);
  if (problem !== undefined) return fail(problem);
  const hooks = deps.hooks.get();
  const card = cardFor(call, spend);
  if (card !== undefined) {
    const input = {
      method: call.method,
      url: call.url,
      host: url.host,
      credential: spend?.item.name ?? null,
    };
    const approved =
      hooks !== undefined &&
      (await hooks.confirm(context.conversationId, context.callId, {
        callId: context.callId,
        name: card,
        input,
      }));
    if (!approved) {
      const note = hooks?.noteFor(context.conversationId, context.callId);
      return fail(
        note ??
          "not approved (denied, stopped, or no answer in time) — do not retry; tell your owner",
      );
    }
    if (spend !== null && card === FIRST_USE_APPROVAL && context.scope !== undefined) {
      deps.bindings?.approveHost(context.scope.owner, spend.item.id, url.host);
    }
  }
  return spendAndReport(deps, context, call, spend);
};

const spendAndReport = async (
  deps: BrokerDeps,
  context: {
    readonly conversationId: string;
    readonly callId: string;
    readonly scope?: { readonly profile: string } | undefined;
  },
  call: HttpCall,
  spend: Spend | null,
) => {
  const scrub = makeRedactor(
    spend === null ? [] : materialForms(spend.material),
    spend?.item.name ?? "secret",
  );
  const base = {
    conversationId: context.conversationId,
    profile: context.scope?.profile ?? null,
    callId: context.callId,
  };
  const startedAt = Date.now();
  const audit = deps.hooks.get()?.audit;
  try {
    const result = await performHttp(
      call,
      spend === null ? null : { material: spend.material, binding: spend.binding },
      {
        allowLocalhostHttp: spend?.binding.allowLocalhostHttp ?? false,
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      },
    );
    audit?.(
      auditEvent(base, call, spend?.item ?? null, startedAt, {
        status: result.status,
        error: null,
      }),
    );
    const body = scrub(result.body);
    const report = {
      status: result.status,
      url: scrub(result.url),
      contentType: result.contentType,
      redirects: result.redirects,
      ...(result.authDropped ? { authDropped: true } : {}),
      truncated: result.truncated || body.length > BODY_CHARS,
      body: body.slice(0, BODY_CHARS),
    };
    return {
      isError: result.status >= 400,
      output: [{ type: "text" as const, text: JSON.stringify(report) }],
    };
  } catch (cause) {
    const error = scrub(cause instanceof Error ? cause.message : String(cause)).slice(0, 300);
    audit?.(auditEvent(base, call, spend?.item ?? null, startedAt, { status: null, error }));
    return fail(`request failed: ${error}`);
  }
};

/** The broker plugin: installs `http_request` (credential-less calls work without a vault). */
export const brokerPlugin = (deps: BrokerDeps): Plugin =>
  definePlugin({
    id: "ultiv.broker",
    version: "1.0.0",
    description:
      "Credential broker: guarded HTTPS egress that spends vault secrets without revealing them.",
    capabilities: [toolCapability(httpRequestTool(deps))],
  });

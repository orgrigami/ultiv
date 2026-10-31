/**
 * OAuth 2.1 for remote MCP servers, per the MCP authorization spec. The SDK
 * does discovery (protected-resource + authorization-server metadata),
 * dynamic client registration, PKCE, the `resource` parameter and refresh;
 * this provider persists its state SEALED under the vault KEK
 * (`<vault>/<owner>/mcp-oauth/<id>.json`) and binds every authorization
 * request to a single-use `state` the callback must present (the SDK does
 * not check `state` itself).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolveInside } from "@spreissen/core";
import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { openSealed, sealValue, type Sealed } from "../vault.ts";
import { secretForms } from "../broker/redact.ts";

interface OAuthState {
  tokens?: StoredOAuthTokens;
  client?: StoredOAuthClientInformation;
  /** The redirect URL the stored client was registered with. */
  clientRedirect?: string;
  verifier?: string;
}

/** Sealed per-server OAuth state on disk. */
export interface OAuthStore {
  readonly read: (owner: string, id: string) => OAuthState;
  readonly write: (owner: string, id: string, state: OAuthState) => void;
  readonly clear: (owner: string, id: string) => void;
  readonly hasTokens: (owner: string, id: string) => boolean;
}

export const makeOAuthStore = (vaultRoot: string): OAuthStore => {
  const fileOf = (owner: string, id: string): string =>
    resolveInside(vaultRoot, owner, "mcp-oauth", `${id}.json`);
  const read = (owner: string, id: string): OAuthState => {
    const path = fileOf(owner, id);
    if (!existsSync(path)) return {};
    try {
      return openSealed(JSON.parse(readFileSync(path, "utf8")) as Sealed) as OAuthState;
    } catch {
      // Unreadable (VAULT_KEY changed): start over rather than fail forever.
      return {};
    }
  };
  return {
    read,
    write: (owner, id, state) => {
      mkdirSync(resolveInside(vaultRoot, owner, "mcp-oauth"), { recursive: true, mode: 0o700 });
      writeFileSync(fileOf(owner, id), JSON.stringify(sealValue(state)), { mode: 0o600 });
    },
    clear: (owner, id) => rmSync(fileOf(owner, id), { force: true }),
    hasTokens: (owner, id) => read(owner, id).tokens !== undefined,
  };
};

/** Pending authorization requests: state → server, single use, 10 minutes. */
export interface OAuthPending {
  readonly mint: (owner: string, id: string) => string;
  readonly take: (state: string) => { readonly owner: string; readonly id: string } | undefined;
}

export const makeOAuthPending = (ttlMs = 10 * 60_000): OAuthPending => {
  const pending = new Map<string, { owner: string; id: string; expiresAt: number }>();
  return {
    mint: (owner, id) => {
      const now = Date.now();
      for (const [key, entry] of pending) if (entry.expiresAt < now) pending.delete(key);
      const state = randomBytes(24).toString("base64url");
      pending.set(state, { owner, id, expiresAt: now + ttlMs });
      return state;
    },
    take: (state) => {
      const entry = pending.get(state);
      if (entry === undefined) return undefined;
      pending.delete(state);
      return entry.expiresAt < Date.now() ? undefined : { owner: entry.owner, id: entry.id };
    },
  };
};

export interface ProviderOptions {
  readonly store: OAuthStore;
  readonly pending: OAuthPending;
  readonly owner: string;
  readonly id: string;
  readonly redirectUrl: string;
  readonly scope?: string;
  readonly clientId?: string;
  /** Redeemed from the vault; turns the client confidential (secret_basic). */
  readonly clientSecret?: string;
  /** Extra query parameters on the authorization redirect (provider quirks). */
  readonly authParams?: readonly { readonly name: string; readonly value: string }[];
  /** Where the SDK would send the browser: kept for the Connect button. */
  readonly onRedirect: (url: string) => void;
  /** New token material, for the redactor. */
  readonly onSecretForms: (forms: readonly string[]) => void;
}

const tokenForms = (tokens: StoredOAuthTokens | undefined): string[] =>
  tokens === undefined
    ? []
    : [tokens.access_token, tokens.refresh_token ?? ""].flatMap((value) => secretForms(value));

/** The SDK-facing provider for one server; every write goes to the sealed store. */
export const makeOAuthProvider = (options: ProviderOptions): OAuthClientProvider => {
  const { store, owner, id } = options;
  const update = (change: (state: OAuthState) => void): void => {
    const state = store.read(owner, id);
    change(state);
    store.write(owner, id, state);
  };
  options.onSecretForms(tokenForms(store.read(owner, id).tokens));
  const metadata: OAuthClientMetadata = {
    client_name: "Spreissen",
    redirect_uris: [options.redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    ...(options.clientSecret !== undefined && options.clientSecret !== ""
      ? { token_endpoint_auth_method: "client_secret_basic" as const }
      : { token_endpoint_auth_method: "none" as const }),
    ...(options.scope !== undefined && options.scope !== "" ? { scope: options.scope } : {}),
  };
  return {
    get redirectUrl() {
      return options.redirectUrl;
    },
    get clientMetadata() {
      return metadata;
    },
    state: () => options.pending.mint(owner, id),
    clientInformation: () => {
      const secret =
        options.clientSecret !== undefined && options.clientSecret !== ""
          ? { client_secret: options.clientSecret }
          : {};
      if (options.clientId !== undefined && options.clientId !== "") {
        return { client_id: options.clientId, ...secret };
      }
      const state = store.read(owner, id);
      // A client registered for another redirect URL cannot complete this flow.
      return state.clientRedirect === options.redirectUrl ? state.client : undefined;
    },
    saveClientInformation: (client) =>
      update((state) => {
        state.client = client;
        state.clientRedirect = options.redirectUrl;
      }),
    tokens: () => store.read(owner, id).tokens,
    saveTokens: (tokens) => {
      options.onSecretForms(tokenForms(tokens));
      update((state) => {
        state.tokens = tokens;
      });
    },
    redirectToAuthorization: (url) => {
      // Provider quirks ride the redirect (e.g. Google's access_type=offline
      // for a refresh token) — plain settings, appended last.
      for (const { name, value } of options.authParams ?? []) {
        url.searchParams.set(name, value);
      }
      options.onRedirect(url.toString());
    },
    saveCodeVerifier: (verifier) =>
      update((state) => {
        state.verifier = verifier;
      }),
    codeVerifier: () => {
      const verifier = store.read(owner, id).verifier;
      if (verifier === undefined) throw new Error("no sign-in in progress");
      return verifier;
    },
    invalidateCredentials: (scope) =>
      update((state) => {
        if (scope === "all" || scope === "tokens") delete state.tokens;
        if (scope === "all" || scope === "client") {
          delete state.client;
          delete state.clientRedirect;
        }
        if (scope === "all" || scope === "verifier") delete state.verifier;
      }),
  };
};

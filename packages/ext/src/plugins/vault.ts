/**
 * The vault as model-facing tools — metadata only. `vault_list` shows what
 * exists (masked hints, access class, scope); `vault_contacts` reads the
 * reference class (who to email). No tool returns secret bytes: there is no
 * read path for them at the act surface, by construction.
 */
import { resolveInside } from "@spreissen/core";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import type { VaultStore } from "../vault.ts";

/** Resolves a conversation to its profile scope; absent until the mind wires it. */
export interface ScopeResolver {
  readonly scopeOf: (
    conversationId: string,
  ) => { readonly owner: string; readonly profile: string } | undefined;
}

/** A settable holder, so plugins built before the profiles service resolve lazily. */
export interface ScopeHolder {
  readonly get: () => ScopeResolver | undefined;
  readonly set: (resolver: ScopeResolver) => void;
}

export const createScopeHolder = (): ScopeHolder => {
  let current: ScopeResolver | undefined;
  return {
    get: () => current,
    set: (resolver) => {
      current = resolver;
    },
  };
};

/** The artifact directory for a conversation: {root}/{owner}/{profile}, or the shared root. */
export const scopeDir = (holder: ScopeHolder, conversationId: string, root: string): string => {
  const scope = holder.get()?.scopeOf(conversationId);
  return scope === undefined ? root : resolveInside(root, scope.owner, scope.profile);
};

const listTool = (store: VaultStore, holder: ScopeHolder): Tool =>
  defineTool({
    name: "vault_list",
    description:
      "List the vault's items for this profile: names, kinds, masked hints (e.g. " +
      "'VISA •••• 4242'), and access class. Secret items are USE-ONLY — no tool returns " +
      "their values, so never claim to know one; if a secret is missing, ask your owner to " +
      "add it in the app's Vault, never in chat. Contacts are " +
      "readable through vault_contacts.",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        kind: Type.String(),
        access: Type.String(),
        masked: Type.String(),
        profile: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    execute: (args, api) => {
      const scope = holder.get()?.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve({
          output: [{ type: "text" as const, text: "[]" }],
          structuredOutput: [],
        });
      }
      const items = store
        .list(scope.owner, { profile: scope.profile })
        .map(({ id, name, kind, access, masked, profile }) => ({
          id,
          name,
          kind,
          access,
          masked,
          profile,
        }));
      return Promise.resolve({
        output: [{ type: "text" as const, text: JSON.stringify(items) }],
        structuredOutput: items,
      });
    },
  });

const contactsTool = (store: VaultStore, holder: ScopeHolder): Tool =>
  defineTool({
    name: "vault_contacts",
    description:
      "Search the vault's contacts (reference class): who to email or call, with the " +
      "address the user stored. Use it to resolve 'email Mom' into a real address. Contacts " +
      "are your owner's personal data: use them for the task at hand, and never pass them to " +
      "other bots, rooms or webhooks unless your owner asked.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Name or email substring." })),
    }),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        email: Type.Union([Type.String(), Type.Null()]),
        phone: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
    execute: (args, api) => {
      const scope = holder.get()?.scopeOf(String(api.conversationId));
      if (scope === undefined) {
        return Promise.resolve({
          output: [{ type: "text" as const, text: "[]" }],
          structuredOutput: [],
        });
      }
      const report = store.contactsReport(scope.owner, {
        profile: scope.profile,
        ...(args.query !== undefined ? { query: args.query } : {}),
      });
      const contacts = report.contacts.map(({ id, name, email, phone }) => ({
        id,
        name,
        email,
        phone,
      }));
      const skipped = report.unreadable.map((item) => item.name).join(", ");
      const warning =
        report.unreadable.length === 0
          ? ""
          : `\nWarning: ${report.unreadable.length} contact(s) could not be opened (${skipped}). ` +
            "The vault key may have changed since they were saved; tell your owner.";
      return Promise.resolve({
        output: [{ type: "text" as const, text: JSON.stringify(contacts) + warning }],
        structuredOutput: contacts,
      });
    },
  });

/** The vault plugin: metadata + contacts. Installs only when VAULT_KEY is set. */
export const vaultPlugin = (store: VaultStore, holder: ScopeHolder): Plugin =>
  definePlugin({
    id: "ultiv.vault",
    version: "1.0.0",
    description:
      "The credential vault: masked metadata and readable contacts — secrets stay sealed.",
    capabilities: [
      toolCapability(listTool(store, holder)),
      toolCapability(contactsTool(store, holder)),
    ],
  });

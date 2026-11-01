/**
 * The vault as model-facing tools — metadata only. `vault_list` shows what
 * exists (masked hints, access class, scope); `vault_contacts` reads the
 * reference class (who to email). No tool returns secret bytes: there is no
 * read path for them at the act surface, by construction.
 */
import { resolveInside } from "@spriessen/core";
import { Type } from "typebox";
import { definePlugin, toolCapability, type Plugin } from "../plugin.ts";
import { defineTool, type Tool } from "../tool.ts";
import type { VaultStore } from "../vault.ts";

/** Resolves a conversation to its profile scope; absent until the mind wires it. */
export interface ScopeResolver {
  readonly scopeOf: (
    conversationId: string,
  ) => { readonly owner: string; readonly profile: string } | undefined;
  /**
   * The conversation's HOME scope, when the embedder gives each home (an org
   * or a department) its own sandbox instead of each bot: `dir` names the
   * home's VM (a stable scope dir; the sandbox name derives from it) and
   * `sharedGid` is the home's shared-folder group id, when it provisions
   * one. ext never learns org concepts — the mind supplies both. The
   * resolver takes NO target: a bot's `bash` runs only in its home's VM
   * (owner decision, 1 Nov 2026 — no cross-home command execution). Absent
   * (or undefined per conversation) keeps the per-bot sandbox of older
   * embedders.
   */
  readonly homeScopeOf?: (
    conversationId: string,
  ) => HomeScope | undefined | Promise<HomeScope | undefined>;
}

/** The bot's own Linux identity inside a VM (slice 2b); the mind supplies it. */
export interface SandboxUser {
  /** Linux user name (`bot-<hash>`; /etc/passwd length rules apply). */
  readonly name: string;
  /** Fixed per-bot uid from 10000 up; the SAME uid in every VM. */
  readonly uid: number;
  /** The user's own group id (allocated equal to the uid). */
  readonly gid: number;
  /** The bot's home directory inside the VM (`/home/<folder>`). */
  readonly home: string;
}

/** The home scope one conversation's bot shares with its home's other bots. */
export interface HomeScope {
  /** Stable scope dir naming the home's VM (the sandbox name derives from it). */
  readonly dir: string;
  /** Gid of the home's `/home/shared` group, when the home provisions one. */
  readonly sharedGid?: number;
  /**
   * The org-wide folder (slice 2c): one host-side store, mounted at
   * `/home/org-shared` into EVERY VM — read-write in the org VM, read-only
   * in a department VM (enforced by the mount, never file modes alone).
   * `gid` is the org's own org-shared group, separate from every
   * department's group. ext never learns org concepts — the mind supplies
   * the store path and gid.
   */
  readonly orgShared?: {
    /** Durable host directory backing the mount. */
    readonly hostDir: string;
    /** The org's org-shared group id (fixed from 10000 up, stored with the org). */
    readonly gid: number;
    /** True for a department VM: the mount is read-only. */
    readonly readOnly: boolean;
  };
  /**
   * The department's own durable store (slice 2d): when set, the VM's
   * `/home/shared` is a bind mount of this host directory — the SAME store
   * the org VM sees at `/home/dept-shared/<department id>`.
   */
  readonly sharedStore?: string;
  /**
   * The org VM's department shared folders (slice 2d), for ORG bots only:
   * the per-org parent directory mounted at `/home/dept-shared` (its
   * subfolders are the department stores), the stored departments (ids and
   * gids) and every org bot that already has a Linux user (for group
   * reconciliation). ext never learns org concepts — the mind supplies all.
   */
  readonly deptShared?: {
    readonly parentDir: string;
    readonly depts: readonly { readonly id: string; readonly gid: number }[];
    readonly users: readonly string[];
  };
  /**
   * The bot's own Linux user in the VM (uid, group, home). When set, the VM
   * provisions it idempotently on boot and every bot command runs as it;
   * root remains only for provisioning, `prepare` and the file sync.
   */
  readonly user?: SandboxUser;
  /**
   * The home's network allowlist (slice 3): named hosts the VM may reach,
   * everything else denied (an absent or empty list = fully offline, the
   * default). ext never learns org concepts — the mind supplies it.
   */
  readonly netAllowlist?: readonly string[];
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

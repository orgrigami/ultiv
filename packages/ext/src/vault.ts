/**
 * The Vault: a credential broker, not a reader. Secrets are sealed at rest
 * (per-item AES-256-GCM DEK, wrapped by a KEK derived from VAULT_KEY) and the
 * only model-facing surface is metadata plus masked hints. Access classes:
 * `secret` items (login/card/key/note) are use-only — redeemed server-side by
 * connectors and future executors; `contact` items are reference — readable,
 * because "who to email" is data, not a credential. No function here ever
 * returns secret bytes to a caller that will hand them to a model.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { InvalidInput, NotFound, resolveInside, tryResolveInside } from "@spreissen/core";
import type { VaultContact, VaultItemCreate, VaultItemInfo } from "@spreissen/contracts";

/** The vault root (relative to the server's cwd, like HARNESS_DB). */
export const vaultDir = (): string => {
  const configured = process.env.VAULT_DIR?.trim();
  return configured !== undefined && configured !== "" ? configured : "var/vault";
};

/** True when VAULT_KEY is present — the store can seal and open. */
export const vaultConfigured = (): boolean => {
  const key = process.env.VAULT_KEY?.trim();
  return key !== undefined && key !== "";
};

// The salt keeps its pre-rename spelling: changing it would make every stored
// secret unreadable.
const kekOf = (): Buffer => scryptSync(process.env.VAULT_KEY ?? "", "ultiv-vault/v1", 32);

/** Sealed secret payload: the value under a per-item DEK, the DEK under the KEK. */
export interface Sealed {
  /** The secret, encrypted with the DEK. */
  readonly dekIv: string;
  readonly dekTag: string;
  readonly dekCt: string;
  /** The DEK, wrapped with the KEK (rotation re-wraps only this half). */
  readonly wrapIv: string;
  readonly wrapTag: string;
  readonly wrapCt: string;
}

interface VaultItem {
  info: VaultItemInfo;
  sealed: Sealed | null;
}

interface StoredVaultItem {
  info: VaultItemInfo;
  sealed?: Sealed | null;
}

const encryptWith = (key: Buffer, data: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
};

const decryptWith = (key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer): Buffer => {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
};

const seal = (kek: Buffer, value: unknown): Sealed => {
  const dek = randomBytes(32);
  const inner = encryptWith(dek, Buffer.from(JSON.stringify(value), "utf8"));
  const wrapped = encryptWith(kek, dek);
  return {
    dekIv: inner.iv.toString("base64"),
    dekTag: inner.tag.toString("base64"),
    dekCt: inner.ct.toString("base64"),
    wrapIv: wrapped.iv.toString("base64"),
    wrapTag: wrapped.tag.toString("base64"),
    wrapCt: wrapped.ct.toString("base64"),
  };
};

const open = (kek: Buffer, sealed: Sealed): unknown => {
  const dek = decryptWith(
    kek,
    Buffer.from(sealed.wrapIv, "base64"),
    Buffer.from(sealed.wrapTag, "base64"),
    Buffer.from(sealed.wrapCt, "base64"),
  );
  const plain = decryptWith(
    dek,
    Buffer.from(sealed.dekIv, "base64"),
    Buffer.from(sealed.dekTag, "base64"),
    Buffer.from(sealed.dekCt, "base64"),
  );
  return JSON.parse(plain.toString("utf8")) as unknown;
};

/** Seal any JSON value under the vault KEK (MCP OAuth tokens ride this). */
export const sealValue = (value: unknown): Sealed => seal(kekOf(), value);

/** Open a value sealed by `sealValue`; throws when VAULT_KEY changed. */
export const openSealed = (sealed: Sealed): unknown => open(kekOf(), sealed);

const hostOf = (url: string | undefined): string => {
  try {
    return url !== undefined ? new URL(url).host : "";
  } catch {
    return "";
  }
};

const maskOf = (input: VaultItemCreate): string => {
  switch (input.kind) {
    case "login": {
      const host = hostOf(input.login?.url);
      return host === "" ? (input.login?.username ?? "login") : `${input.login?.username}@${host}`;
    }
    case "card": {
      const digits = (input.card?.number ?? "").replace(/\D/g, "");
      const last4 = digits.slice(-4);
      return `${input.card?.brand ?? "CARD"} •••• ${last4}`;
    }
    case "key":
      // No characters of a key ever surface — even a two-char prefix narrows
      // guesses (sk-, ghp_, …). The service label identifies the item.
      return `${input.key?.service ?? "key"} ••••`;
    case "note":
      return "sealed note";
    case "contact":
      return input.contact?.email !== undefined
        ? `${input.name} ⟨${input.contact.email}⟩`
        : input.name;
  }
};

/** The readable secret payload per kind (never model-facing). */
export type VaultSecret =
  | { kind: "login"; url: string | null; username: string; password: string; totp: string | null }
  | {
      kind: "card";
      brand: string | null;
      number: string;
      exp: string;
      cvc: string;
      billing: string | null;
    }
  | { kind: "key"; service: string | null; secret: string }
  | { kind: "note"; secret: string }
  | { kind: "contact"; email: string | null; phone: string | null; note: string | null };

const secretOf = (input: VaultItemCreate): VaultSecret => {
  switch (input.kind) {
    case "login":
      if (input.login === undefined)
        throw new InvalidInput({ reason: "login fields are required" });
      return {
        kind: "login",
        url: input.login.url ?? null,
        username: input.login.username,
        password: input.login.password,
        totp: input.login.totp ?? null,
      };
    case "card":
      if (input.card === undefined) throw new InvalidInput({ reason: "card fields are required" });
      return {
        kind: "card",
        brand: input.card.brand ?? null,
        number: input.card.number,
        exp: input.card.exp,
        cvc: input.card.cvc,
        billing: input.card.billing ?? null,
      };
    case "key":
      if (input.key === undefined) throw new InvalidInput({ reason: "key fields are required" });
      return { kind: "key", service: input.key.service ?? null, secret: input.key.secret };
    case "note":
      if (input.note === undefined) throw new InvalidInput({ reason: "note fields are required" });
      return { kind: "note", secret: input.note.secret };
    case "contact":
      return {
        kind: "contact",
        email: input.contact?.email ?? null,
        phone: input.contact?.phone ?? null,
        note: input.contact?.note ?? null,
      };
  }
};

/** One vault grant: short-lived, single-use, purpose-bound (executor seam). */
export interface VaultGrant {
  readonly token: string;
  readonly owner: string;
  readonly itemId: string;
  readonly purpose: string;
  readonly expiresAt: number;
}

export interface VaultStore {
  readonly create: (owner: string, input: VaultItemCreate) => VaultItemInfo;
  readonly list: (owner: string, scope?: { readonly profile?: string }) => readonly VaultItemInfo[];
  readonly get: (owner: string, id: string) => VaultItemInfo | undefined;
  readonly remove: (owner: string, id: string) => boolean;
  /** Redeem one secret in-process (connector auth, executor). */
  readonly resolve: (owner: string, id: string) => VaultSecret | undefined;
  /** Readable contacts (reference class), optionally by query. */
  readonly contacts: (
    owner: string,
    scope?: { readonly profile?: string; readonly query?: string },
  ) => readonly VaultContact[];
  /** Contacts plus the items that could not be opened (e.g. after a VAULT_KEY change). */
  readonly contactsReport: (
    owner: string,
    scope?: { readonly profile?: string; readonly query?: string },
  ) => ContactsReport;
  readonly mintGrant: (owner: string, id: string, purpose: string) => VaultGrant | undefined;
  readonly redeemGrant: (
    token: string,
  ) => { readonly owner: string; readonly secret: VaultSecret } | undefined;
  /** Remove every profile-scoped item of one profile (purge cascade). */
  readonly removeProfile: (owner: string, profileId: string) => number;
  /** Export one item's sealed form (portability; opens only under the same VAULT_KEY). */
  readonly exportItem: (
    owner: string,
    id: string,
  ) => { readonly info: VaultItemInfo; readonly sealed: Sealed | null } | undefined;
  /** Import a sealed item verbatim, remapping its profile scope. */
  readonly importItem: (
    owner: string,
    item: { readonly info: VaultItemInfo; readonly sealed: Sealed | null },
    profileId: string,
  ) => VaultItemInfo;
}

/** What a contacts lookup found, and what it had to skip. */
export interface ContactsReport {
  readonly contacts: readonly VaultContact[];
  /** Contact items that exist but could not be decrypted (wrong or changed VAULT_KEY). */
  readonly unreadable: readonly { readonly id: string; readonly name: string }[];
}

/**
 * Open every contact in scope. One item that fails to decrypt (a changed
 * VAULT_KEY, a damaged file) is skipped and reported, never fatal to the rest.
 */
const contactsOf = (
  store: VaultStore,
  owner: string,
  scope?: { readonly profile?: string; readonly query?: string },
): ContactsReport => {
  const query = scope?.query?.trim().toLowerCase() ?? "";
  const unreadable: { id: string; name: string }[] = [];
  const contacts = store
    .list(owner, scope)
    .filter((info) => info.kind === "contact")
    .flatMap((info): VaultContact[] => {
      let secret: VaultSecret | undefined;
      try {
        secret = store.resolve(owner, info.id);
      } catch {
        unreadable.push({ id: info.id, name: info.name });
        return [];
      }
      if (secret?.kind !== "contact") return [];
      const { email, phone, note } = secret;
      return [{ id: info.id, name: info.name, email, phone, note, profile: info.profile }];
    })
    .filter((contact) => {
      if (query === "") return true;
      return (
        contact.name.toLowerCase().includes(query) ||
        (contact.email ?? "").toLowerCase().includes(query)
      );
    });
  if (unreadable.length > 0) {
    console.warn(
      `[vault] ${unreadable.length} contact item(s) could not be decrypted for ${owner}; ` +
        "VAULT_KEY may have changed since they were saved",
    );
  }
  return { contacts, unreadable };
};

export const makeVaultStore = (root: string = vaultDir()): VaultStore => {
  const itemsDir = (owner: string): string => resolveInside(root, owner, "items");
  const sidecarOf = (owner: string, id: string): string =>
    resolveInside(itemsDir(owner), `${id}.json`);
  const grants = new Map<string, VaultGrant>();

  const readItem = (owner: string, id: string): VaultItem | undefined => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) return undefined;
    const path = tryResolveInside(itemsDir(owner), `${id}.json`);
    if (path === undefined || !existsSync(path)) return undefined;
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredVaultItem;
    return { info: stored.info, sealed: stored.sealed ?? null };
  };

  const writeItem = (owner: string, item: VaultItem): void => {
    mkdirSync(itemsDir(owner), { recursive: true });
    writeFileSync(sidecarOf(owner, item.info.id), JSON.stringify(item));
  };

  const inScope = (info: VaultItemInfo, scope?: { readonly profile?: string }): boolean => {
    if (scope?.profile === undefined) return true;
    return info.profile === null || info.profile === scope.profile;
  };

  const store: VaultStore = {
    create: (owner, input) => {
      if (!vaultConfigured()) {
        throw new InvalidInput({ reason: "VAULT_KEY is not set — the vault cannot seal items" });
      }
      const secret = secretOf(input);
      const info: VaultItemInfo = {
        id: randomUUID(),
        owner,
        profile: input.profile ?? null,
        kind: input.kind,
        name: input.name.trim().slice(0, 120),
        access: input.kind === "contact" ? "reference" : "secret",
        masked: maskOf(input),
        createdAt: Date.now(),
        lastUsedAt: null,
      };
      writeItem(owner, { info, sealed: seal(kekOf(), secret) });
      return info;
    },
    list: (owner, scope) => {
      const dir = itemsDir(owner);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((file) => file.endsWith(".json"))
        .flatMap((file) => {
          try {
            const path = tryResolveInside(dir, file);
            if (path === undefined) return [];
            return [(JSON.parse(readFileSync(path, "utf8")) as StoredVaultItem).info];
          } catch {
            return [];
          }
        })
        .filter((info) => inScope(info, scope))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    get: (owner, id) => readItem(owner, id)?.info,
    remove: (owner, id) => {
      const path = sidecarOf(owner, id);
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    },
    resolve: (owner, id) => {
      const item = readItem(owner, id);
      if (item === undefined) return undefined;
      if (item.sealed === null) return undefined;
      const secret = open(kekOf(), item.sealed) as VaultSecret;
      writeItem(owner, { info: { ...item.info, lastUsedAt: Date.now() }, sealed: item.sealed });
      return secret;
    },
    contacts: (owner, scope) => contactsOf(store, owner, scope).contacts,
    contactsReport: (owner, scope) => contactsOf(store, owner, scope),
    mintGrant: (owner, id, purpose) => {
      if (store.resolve(owner, id) === undefined) return undefined;
      const grant: VaultGrant = {
        token: randomUUID(),
        owner,
        itemId: id,
        purpose,
        expiresAt: Date.now() + 60_000,
      };
      grants.set(grant.token, grant);
      return grant;
    },
    redeemGrant: (token) => {
      const grant = grants.get(token);
      if (grant === undefined) return undefined;
      grants.delete(token);
      if (grant.expiresAt < Date.now()) return undefined;
      const secret = store.resolve(grant.owner, grant.itemId);
      return secret === undefined ? undefined : { owner: grant.owner, secret };
    },
    removeProfile: (owner, profileId) => {
      let removed = 0;
      for (const info of store.list(owner, { profile: profileId })) {
        if (info.profile === profileId && store.remove(owner, info.id)) removed += 1;
      }
      return removed;
    },
    exportItem: (owner, id) => {
      const item = readItem(owner, id);
      return item === undefined ? undefined : { info: item.info, sealed: item.sealed };
    },
    importItem: (owner, item, profileId) => {
      const info: VaultItemInfo = { ...item.info, owner, profile: profileId };
      writeItem(owner, { info, sealed: item.sealed });
      return info;
    },
  };
  return store;
};

/** The connector-auth view of one owner's vault: item id → api key material. */
export const vaultAuthSource = (store: VaultStore, owner: string) => ({
  resolveItem: (itemId: string): { readonly apiKey?: string } | undefined => {
    const secret = store.resolve(owner, itemId);
    if (secret === undefined) return undefined;
    if (secret.kind === "key" || secret.kind === "note") return { apiKey: secret.secret };
    if (secret.kind === "login") return { apiKey: secret.password };
    return undefined;
  },
});

export { NotFound as VaultNotFound };

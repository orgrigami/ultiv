/**
 * Saved sign-ins: a bot's browser cookies for the sites it actually signed
 * in to (a takeover the owner finished, a vault login that filled), kept
 * between sessions so a sign-in done once — a passkey, a phone prompt —
 * serves the next day's routine too. Sealed with the vault key beside the
 * vault ({vault}/browser-signins/{owner}/{profile}.json); only the site
 * names sit in the clear, for the owner's list. Cookies never reach a model
 * or a bot's files. The user agent they were made under is kept with them:
 * a site that ties a session to the browser it saw keeps honouring it. The
 * owner's Forget deletes the file; removing the bot should too.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveInside } from "@spriessen/core";
import { openSealed, sealValue, vaultConfigured, vaultDir, type Sealed } from "../vault.ts";

export type SavedCookie = { readonly domain?: unknown } & Readonly<Record<string, unknown>>;

export interface SavedSignin {
  readonly sites: readonly string[];
  readonly savedAt: number;
  readonly ua: string;
  readonly cookies: readonly SavedCookie[];
}

export interface SigninSummary {
  readonly profile: string;
  readonly sites: readonly string[];
  readonly savedAt: number;
}

export interface SigninStore {
  /** The sites a bot has saved sign-ins for (no unsealing). */
  readonly sites: (owner: string, profile: string) => SigninSummary | undefined;
  readonly list: (owner: string) => readonly SigninSummary[];
  readonly load: (owner: string, profile: string) => SavedSignin | undefined;
  /** Merge: these sites' cookies replace what was kept for them; other sites stay. */
  readonly save: (
    owner: string,
    profile: string,
    record: Pick<SavedSignin, "sites" | "ua" | "cookies">,
  ) => void;
  readonly forget: (owner: string, profile: string) => boolean;
}

/** Two-label public suffixes common enough to matter (co.id, co.uk, com.au, …). */
const SECOND_LEVEL =
  /^(co|com|net|org|ac|go|or|web|sch|gov|edu|ne|ltd|plc|mil|biz|my|id)\.[a-z]{2}$/;

/** A host's site: its registrable domain (accounts.google.com → google.com). */
export const siteOf = (host: string): string => {
  const bare = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (/^[\d.]+$/.test(bare) || bare.includes(":") || !bare.includes(".")) return bare;
  const labels = bare.split(".");
  const two = labels.slice(-2).join(".");
  return SECOND_LEVEL.test(two) && labels.length > 2 ? labels.slice(-3).join(".") : two;
};

const onSite = (cookie: SavedCookie, site: string): boolean => {
  const domain = String(cookie.domain ?? "")
    .toLowerCase()
    .replace(/^\./, "");
  return domain === site || domain.endsWith(`.${site}`);
};

type StoredFile = {
  readonly v: 1;
  readonly sites: string[];
  readonly savedAt: number;
  readonly sealed: Sealed;
};

export const signinStore = (root?: string): SigninStore | undefined => {
  if (!vaultConfigured()) return undefined;
  const base = join(root ?? vaultDir(), "browser-signins");
  const fileOf = (owner: string, profile: string): string =>
    resolveInside(base, `${owner}/${profile}.json`);
  const read = (owner: string, profile: string): StoredFile | undefined => {
    const path = fileOf(owner, profile);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as StoredFile;
    } catch {
      return undefined;
    }
  };
  const load = (owner: string, profile: string): SavedSignin | undefined => {
    const stored = read(owner, profile);
    if (stored === undefined) return undefined;
    try {
      const inner = openSealed(stored.sealed) as { ua?: unknown; cookies?: unknown };
      return {
        sites: stored.sites,
        savedAt: stored.savedAt,
        ua: typeof inner.ua === "string" ? inner.ua : "",
        cookies: Array.isArray(inner.cookies) ? (inner.cookies as SavedCookie[]) : [],
      };
    } catch {
      // A changed vault key: the saved sign-ins are unreadable, so gone.
      return undefined;
    }
  };
  return {
    sites: (owner, profile) => {
      const stored = read(owner, profile);
      return stored === undefined
        ? undefined
        : { profile, sites: stored.sites, savedAt: stored.savedAt };
    },
    list: (owner) => {
      const dir = resolveInside(base, owner);
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .flatMap((profile) => {
          const stored = read(owner, profile);
          return stored === undefined
            ? []
            : [{ profile, sites: stored.sites, savedAt: stored.savedAt }];
        });
    },
    load,
    save: (owner, profile, record) => {
      const before = load(owner, profile);
      const sites = [...new Set([...(before?.sites ?? []), ...record.sites])]
        .toSorted()
        .slice(0, 50);
      const kept = (before?.cookies ?? []).filter(
        (cookie) => !record.sites.some((site) => onSite(cookie, site)),
      );
      const cookies = [...kept, ...record.cookies].slice(0, 2_000);
      const stored: StoredFile = {
        v: 1,
        sites,
        savedAt: Date.now(),
        sealed: sealValue({ ua: record.ua || before?.ua || "", cookies }),
      };
      const path = fileOf(owner, profile);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(`${path}.tmp`, JSON.stringify(stored), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
    forget: (owner, profile) => {
      const path = fileOf(owner, profile);
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    },
  };
};

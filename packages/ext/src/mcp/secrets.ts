/**
 * Secrets for one MCP server, redeemed from the vault at connect time and
 * never stored, logged or shown: header values (bearer, API key, custom),
 * stdio env vars, and every encoded form of them for the redactor.
 */
import type { McpServerRecord } from "./config.ts";
import type { VaultStore } from "../vault.ts";
import { InvalidInput } from "@spreissen/core";
import { MIN_SECRET_LENGTH, materialOf } from "../broker/credential.ts";
import { makeRedactor, materialForms, secretForms } from "../broker/redact.ts";

export interface ResolvedSecrets {
  readonly headers: Readonly<Record<string, string>>;
  readonly env: Readonly<Record<string, string>>;
  readonly forms: readonly string[];
}

export type SecretsResult =
  | { readonly ok: true; readonly secrets: ResolvedSecrets }
  | { readonly ok: false; readonly reason: string };

const redeem = (
  vault: VaultStore | null,
  owner: string,
  item: string,
  what: string,
): { ok: true; value: string; forms: string[] } | { ok: false; reason: string } => {
  if (vault === null) return { ok: false, reason: `${what} needs the vault (set VAULT_KEY)` };
  const info = vault.get(owner, item);
  if (info === undefined) return { ok: false, reason: `${what}: the vault item is gone` };
  const material = materialOf(vault.resolve(owner, item));
  if (material === undefined) {
    return { ok: false, reason: `${what}: "${info.name}" is not a key, note or login` };
  }
  if (material.secret.length < MIN_SECRET_LENGTH) {
    return { ok: false, reason: `${what}: "${info.name}" is too short to be a secret` };
  }
  return { ok: true, value: material.secret, forms: materialForms(material) };
};

/** Redeem every vault reference of one server. */
export const resolveSecrets = (
  vault: VaultStore | null,
  record: McpServerRecord,
): SecretsResult => {
  const headers: Record<string, string> = {};
  const env: Record<string, string> = {};
  const forms: string[] = [];
  if (record.auth.kind === "headers") {
    for (const ref of record.auth.headers) {
      const got = redeem(vault, record.owner, ref.item, `header ${ref.name}`);
      if (!got.ok) return got;
      const value = `${ref.prefix ?? ""}${got.value}`;
      headers[ref.name] = value;
      forms.push(...got.forms, ...secretForms(value));
    }
  }
  for (const ref of record.command?.env ?? []) {
    const got = redeem(vault, record.owner, ref.item, `env ${ref.name}`);
    if (!got.ok) return got;
    env[ref.name] = got.value;
    forms.push(...got.forms);
  }
  return { ok: true, secrets: { headers, env, forms: [...new Set(forms)] } };
};

/**
 * The OAuth client secret, redeemed from the vault at provider construction.
 * Absent when the record has no `clientSecretItem`; throws in plain words
 * when the item is gone or unusable (the Connect path surfaces it).
 */
export const clientSecretOf = (
  vault: VaultStore | null,
  record: McpServerRecord,
): string | undefined => {
  if (record.auth.kind !== "oauth" || record.auth.clientSecretItem === undefined) return undefined;
  const got = redeem(vault, record.owner, record.auth.clientSecretItem, "OAuth client secret");
  if (!got.ok) throw new InvalidInput({ reason: got.reason });
  return got.value;
};

/**
 * The OAuth client id, redeemed from the vault when the record references a
 * `clientIdItem` (bots collect it through a secure field). Unlike the
 * secret there is no minimum length — an id is public. Plain `clientId`
 * wins when both are present.
 */
export const clientIdOf = (
  vault: VaultStore | null,
  record: McpServerRecord,
): string | undefined => {
  if (record.auth.kind !== "oauth" || record.auth.clientIdItem === undefined) return undefined;
  if (vault === null) return undefined;
  const info = vault.get(record.owner, record.auth.clientIdItem);
  if (info === undefined) return undefined;
  const material = materialOf(vault.resolve(record.owner, record.auth.clientIdItem));
  return material?.secret;
};

/** A scrubber over a growing set of forms (OAuth tokens join on refresh). */
export interface Scrubber {
  readonly add: (forms: readonly string[]) => void;
  readonly scrub: (text: string) => string;
}

export const makeScrubber = (label: string): Scrubber => {
  const all = new Set<string>();
  let redact = makeRedactor([], label);
  return {
    add: (forms) => {
      const before = all.size;
      for (const form of forms) all.add(form);
      if (all.size !== before) {
        redact = makeRedactor(
          [...all].sort((a, b) => b.length - a.length),
          label,
        );
      }
    },
    scrub: (text) => redact(text),
  };
};

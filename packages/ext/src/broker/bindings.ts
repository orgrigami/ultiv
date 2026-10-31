/**
 * Credential bindings at rest: one JSON file per owner beside the vault's
 * sealed items ({root}/{owner}/bindings.json). Policy only, no secret bytes.
 * Validation is strict: hosts are hostnames, `*.` wildcards, `host:port` or
 * https URL prefixes; named placements need their name.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidInput, resolveInside } from "@spreissen/core";
import type { CredentialBinding, CredentialBindingInput } from "@spreissen/contracts";
import { isLocalhostName } from "./net-guard.ts";

export interface BindingStore {
  readonly list: (owner: string) => readonly CredentialBinding[];
  readonly get: (owner: string, itemId: string) => CredentialBinding | undefined;
  /** Create or replace one item's binding; first-use approvals reset when the hosts change. */
  readonly put: (owner: string, itemId: string, input: CredentialBindingInput) => CredentialBinding;
  readonly remove: (owner: string, itemId: string) => boolean;
  /** Record the owner's first-use approval of this credential on a host. */
  readonly approveHost: (owner: string, itemId: string, host: string) => void;
}

const HOST_ENTRY =
  /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** Normalize one hosts entry, or say why it is not acceptable. */
export const normalizeHostEntry = (raw: string, allowLocalhostHttp: boolean): string => {
  const entry = raw.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(entry)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new InvalidInput({ reason: `not a URL: ${raw}` });
    }
    const local = url.protocol === "http:" && allowLocalhostHttp && isLocalhostName(url.hostname);
    if (url.protocol !== "https:" && !local) {
      throw new InvalidInput({ reason: `URL prefixes must be https: ${raw}` });
    }
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new InvalidInput({
        reason: `URL prefixes take no credentials, query or fragment: ${raw}`,
      });
    }
    return `${url.origin}${url.pathname}`;
  }
  const bareWildcard = entry.startsWith("*.") && !entry.slice(2).includes(".");
  if (!HOST_ENTRY.test(entry) || bareWildcard) {
    throw new InvalidInput({ reason: `not a hostname, *.wildcard or https URL prefix: ${raw}` });
  }
  return entry;
};

/** Validate the editable input; returns the normalized copy. */
export const validateBinding = (input: CredentialBindingInput): CredentialBindingInput => {
  const { placement, name } = input.auth;
  if ((placement === "header" || placement === "query" || placement === "body") && !name?.trim()) {
    throw new InvalidInput({ reason: `${placement} placement needs a name` });
  }
  if (placement === "header" && !/^[a-z0-9!#$%&'*+.^_`|~-]+$/i.test(name ?? "")) {
    throw new InvalidInput({ reason: "header name has invalid characters" });
  }
  if (
    placement === "header" &&
    /^(cookie|host|proxy-authorization|content-length|transfer-encoding|connection)$/i.test(
      name ?? "",
    )
  ) {
    throw new InvalidInput({ reason: `header placement cannot target ${name}` });
  }
  const hosts = [
    ...new Set(input.hosts.map((h) => normalizeHostEntry(h, input.allowLocalhostHttp))),
  ];
  return {
    ...input,
    hosts,
    methods: [...new Set(input.methods)],
    auth: { ...input.auth, ...(name !== undefined ? { name: name.trim() } : {}) },
  };
};

export const makeBindingStore = (root: string): BindingStore => {
  const fileOf = (owner: string): string => resolveInside(root, owner, "bindings.json");
  const read = (owner: string): CredentialBinding[] => {
    const path = fileOf(owner);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as CredentialBinding[];
    } catch {
      return [];
    }
  };
  const write = (owner: string, bindings: readonly CredentialBinding[]): void => {
    mkdirSync(join(root, owner), { recursive: true });
    const path = fileOf(owner);
    writeFileSync(`${path}.tmp`, JSON.stringify(bindings, null, 2));
    renameSync(`${path}.tmp`, path);
  };
  return {
    list: (owner) => read(owner),
    get: (owner, itemId) => read(owner).find((binding) => binding.itemId === itemId),
    put: (owner, itemId, input) => {
      const clean = validateBinding(input);
      const others = read(owner).filter((binding) => binding.itemId !== itemId);
      const previous = read(owner).find((binding) => binding.itemId === itemId);
      const binding: CredentialBinding = {
        ...clean,
        itemId,
        approvedHosts:
          previous !== undefined && previous.hosts.join("\n") === clean.hosts.join("\n")
            ? previous.approvedHosts
            : [],
        updatedAt: Date.now(),
      };
      write(owner, [...others, binding]);
      return binding;
    },
    remove: (owner, itemId) => {
      const all = read(owner);
      const rest = all.filter((binding) => binding.itemId !== itemId);
      if (rest.length === all.length) return false;
      write(owner, rest);
      return true;
    },
    approveHost: (owner, itemId, host) => {
      const all = read(owner);
      const next = all.map((binding) =>
        binding.itemId === itemId && !binding.approvedHosts.includes(host)
          ? { ...binding, approvedHosts: [...binding.approvedHosts, host] }
          : binding,
      );
      write(owner, next);
    },
  };
};

/**
 * Pure helpers for the Vault's credential-binding editor: the draft shape the
 * form edits, its conversion to the API body, a one-line summary, and which
 * bound bots can't actually call `http_request` (their tool allowlist).
 */
import type {
  CredentialBinding,
  CredentialBindingInput,
  HttpAuthPlacement,
  HttpMethod,
  ProfileInfo,
} from "@spreissen/contracts";

export const HTTP_METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export const PLACEMENTS: { value: HttpAuthPlacement; label: string; needsName: boolean }[] = [
  { value: "bearer", label: "Authorization: Bearer", needsName: false },
  { value: "basic", label: "Authorization: Basic", needsName: false },
  { value: "header", label: "Custom header", needsName: true },
  { value: "query", label: "Query parameter", needsName: true },
  { value: "body", label: "JSON body field", needsName: true },
];

export interface BindingDraft {
  hosts: string;
  methods: HttpMethod[];
  placement: HttpAuthPlacement;
  name: string;
  prefix: string;
  /** null = every bot. */
  profiles: string[] | null;
  allowLocalhostHttp: boolean;
}

export const draftOf = (binding: CredentialBinding | undefined): BindingDraft => ({
  hosts: binding?.hosts.join("\n") ?? "",
  methods: binding?.methods ?? ["GET"],
  placement: binding?.auth.placement ?? "bearer",
  name: binding?.auth.name ?? "",
  prefix: binding?.auth.prefix ?? "",
  profiles: binding?.profiles ?? null,
  allowLocalhostHttp: binding?.allowLocalhostHttp ?? false,
});

export const hostsOf = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((host) => host.trim())
    .filter((host) => host !== "");

export const inputOf = (draft: BindingDraft): CredentialBindingInput => {
  const needsName = PLACEMENTS.find((p) => p.value === draft.placement)?.needsName ?? false;
  return {
    adapter: "http",
    hosts: hostsOf(draft.hosts),
    methods: draft.methods,
    auth: {
      placement: draft.placement,
      ...(needsName && draft.name.trim() !== "" ? { name: draft.name.trim() } : {}),
      ...(draft.placement === "header" && draft.prefix !== "" ? { prefix: draft.prefix } : {}),
    },
    profiles: draft.profiles,
    allowLocalhostHttp: draft.allowLocalhostHttp,
  };
};

/** "GET, POST · api.stripe.com +1" */
export const bindingSummary = (binding: CredentialBinding): string => {
  const [first, ...rest] = binding.hosts;
  const where = `${first ?? ""}${rest.length > 0 ? ` +${rest.length}` : ""}`;
  return `${binding.methods.join(", ")} · ${where}`;
};

/** Bots allowed by the binding whose tool allowlist leaves out http_request. */
export const allowlistGaps = (
  profiles: readonly ProfileInfo[],
  allowed: readonly string[] | null,
): ProfileInfo[] =>
  profiles.filter(
    (profile) =>
      (allowed === null || allowed.includes(profile.id)) &&
      profile.toolAllowlist !== null &&
      !profile.toolAllowlist.includes("http_request"),
  );

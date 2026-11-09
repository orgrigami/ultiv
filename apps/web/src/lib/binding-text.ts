/**
 * Pure helpers for the Vault's credential-binding editor: the draft shape the
 * form edits, its conversion to the API body, a one-line summary, and which
 * bound bots can't actually use it (their tool allowlist leaves out
 * `http_request`, or `browser_login` for a browser sign-in). A LOGIN may be
 * bound to the browser instead of web requests: the bot then signs in with
 * it on those sites (methods, placement and localhost do not apply).
 */
import type {
  CredentialAdapter,
  CredentialBinding,
  CredentialBindingInput,
  HttpAuthPlacement,
  HttpMethod,
  ProfileInfo,
} from "@spriessen/contracts";

export const HTTP_METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export const PLACEMENTS: { value: HttpAuthPlacement; label: string; needsName: boolean }[] = [
  { value: "bearer", label: "Authorization: Bearer", needsName: false },
  { value: "basic", label: "Authorization: Basic", needsName: false },
  { value: "header", label: "Custom header", needsName: true },
  { value: "query", label: "Query parameter", needsName: true },
  { value: "body", label: "JSON body field", needsName: true },
];

export interface BindingDraft {
  /** `http` (web requests) or `browser` (sign in on those sites). */
  adapter: CredentialAdapter;
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
  adapter: binding?.adapter ?? "http",
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
  if (draft.adapter === "browser") {
    return {
      adapter: "browser",
      hosts: hostsOf(draft.hosts),
      // Unused by the browser adapter; the schema still wants them.
      methods: ["GET"],
      auth: { placement: "bearer" },
      profiles: draft.profiles,
      allowLocalhostHttp: false,
    };
  }
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

/** "Web: GET, POST · api.stripe.com +1", or "Browser sign-in · accounts.google.com". */
export const bindingSummary = (binding: CredentialBinding): string => {
  const [first, ...rest] = binding.hosts;
  const where = `${first ?? ""}${rest.length > 0 ? ` +${rest.length}` : ""}`;
  return binding.adapter === "browser"
    ? `Browser sign-in · ${where}`
    : `Web: ${binding.methods.join(", ")} · ${where}`;
};

/** The tool a bound bot needs in its allowlist to use the credential. */
export const toolOfAdapter = (adapter: CredentialAdapter): string =>
  adapter === "browser" ? "browser_login" : "http_request";

/** Bots allowed by the binding whose tool allowlist leaves out http_request. */
export const allowlistGaps = (
  profiles: readonly ProfileInfo[],
  allowed: readonly string[] | null,
  tool = "http_request",
): ProfileInfo[] =>
  profiles.filter(
    (profile) =>
      (allowed === null || allowed.includes(profile.id)) &&
      profile.toolAllowlist !== null &&
      !profile.toolAllowlist.includes(tool),
  );

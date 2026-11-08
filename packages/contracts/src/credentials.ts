import {
  arr,
  bool,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";

/**
 * Credential bindings: which vault item an adapter may use, where, and how.
 * The broker is protocol-generic (`adapter`); HTTP is the first adapter, and
 * ssh/git/SMTP/IMAP/DB/env adapters add their own literals later. A binding
 * holds no secret bytes: only the policy around one sealed vault item.
 */
export const CredentialAdapterSchema = oneOf(["http"]);

export type CredentialAdapter = Static<typeof CredentialAdapterSchema>;

/** Where the HTTP adapter places the secret on a request. */
export const HttpAuthPlacementSchema = oneOf(["bearer", "basic", "header", "query", "body"]);

export type HttpAuthPlacement = Static<typeof HttpAuthPlacementSchema>;

export const HttpMethodSchema = oneOf(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export type HttpMethod = Static<typeof HttpMethodSchema>;

/** The editable part of a binding (the Vault screen's form). */
const CredentialBindingInputProperties = {
  adapter: CredentialAdapterSchema,
  /**
   * Allowed targets: a hostname (`api.github.com`), a subdomain wildcard
   * (`*.example.com`), `host:port`, or an https URL prefix
   * (`https://api.example.com/v1/`).
   */
  hosts: arr(str({ minLength: 1, maxLength: 300 }), { minItems: 1, maxItems: 20 }),
  methods: arr(HttpMethodSchema, { minItems: 1 }),
  auth: obj(
    {
      placement: HttpAuthPlacementSchema,
      /** Header name (header), query parameter (query) or JSON field (body). */
      name: opt(str({ minLength: 1, maxLength: 100 })),
      /** Optional value prefix for `header` placement, e.g. `Token `. */
      prefix: opt(str({ maxLength: 40 })),
    },
    { open: true },
  ),
  /** Profiles (bots) that may use it; null = every profile the item is visible to. */
  profiles: union([arr(str()), nul()]),
  /** Plain http to localhost/127.0.0.1/[::1] only; everything else is https. */
  allowLocalhostHttp: bool(),
};

export const CredentialBindingInputSchema = obj(CredentialBindingInputProperties, { open: true });

export type CredentialBindingInput = Static<typeof CredentialBindingInputSchema>;

export const CredentialBindingSchema = obj(
  {
    ...CredentialBindingInputProperties,
    itemId: str(),
    /** Hosts the owner already approved this credential on (first-use cards). */
    approvedHosts: arr(str()),
    updatedAt: num(),
  },
  { open: true },
);

export type CredentialBinding = Static<typeof CredentialBindingSchema>;

export const CredentialBindingListSchema = arr(CredentialBindingSchema);

export type CredentialBindingList = Static<typeof CredentialBindingListSchema>;

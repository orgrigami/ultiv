# @spreissen/ext

The extension platform: the standard future development plugs into.

- `tool.ts` — the one tool surface (pi-durable's `ToolRegistration` shape plus a
  `gated` flag for side-effecting tools; the approval broker wraps those at the
  act, never reads). pi-durable is a **type-only** dependency here — no runtime
  import — so tools stay harness-shaped without coupling the registry to it.
- `connector.ts` — the connector standard: identity, env-backed auth, and
  TypeBox-typed actions with Effect `perform`s, invoked through `invoke`
  (validate -> authenticate -> perform).
- `plugin.ts` — the unit of extension: a named, versioned bundle of
  capabilities (`tool`, `connector`; new kinds extend the union).
- `registry.ts` — the `Registry` service: install plugins, resolve capabilities,
  reject duplicate identities.
- `plugins/http.ts` — the reference connector (generic HTTP egress); proof the
  standard needs no special-casing.

Lifecycle is Effect layering, not plugin callbacks: a plugin is declarative
data; composition and teardown belong to the Layers that install it.

# @spreissen/core

The kernel: cross-cutting concerns every other package shares, and nothing else.

- `errors.ts` — the shared tagged-error vocabulary (`NotFound`, `InvalidInput`,
  `Duplicate`, `Unavailable`, `AuthMissing`, `External`). All packages tag
  failures from here so `Effect.catchTag` composes across boundaries.
- `runtime.ts` — the promise-land door into Effect-land: `openRuntime` builds a
  fully-provided Layer into a live service under a caller-owned scope whose
  finalizers run on `close()`.

Rules for this package: no domain knowledge (conversations, connectors — that
belongs above), no runtime deps beyond `effect`.

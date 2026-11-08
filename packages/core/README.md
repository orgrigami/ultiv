# @spriessen/core

The kernel: cross-cutting concerns every other package shares, and nothing else.

- `home.ts` — the one home (`$SPRIESSEN_HOME`, default `~/.spriessen`) and its
  data folder: `dataDir()` / `dataPath()` are the default of every data env
  key. Never hardcode `var/`; an install from before the home keeps its old
  relative `var/…` paths until `spriessen data move`.
- `errors.ts` — the shared tagged-error vocabulary (`NotFound`, `InvalidInput`,
  `Duplicate`, `Unavailable`, `AuthMissing`, `External`). All packages tag
  failures from here so `Effect.catchTag` composes across boundaries.
- `error-text.ts` — `ownerErrorText`: any error as one owner-readable sentence,
  secrets scrubbed (the chat's error banner, a failed task's error).
- `runtime.ts` — the promise-land door into Effect-land: `openRuntime` builds a
  fully-provided Layer into a live service under a caller-owned scope whose
  finalizers run on `close()`.
- `safe-path.ts` — `resolveInside` / `tryResolveInside`: join a caller-supplied
  id or path onto a folder, refusing `../`, absolute parts and symlinks out.
- `env.ts` — `readEnv`: `SPRIESSEN_*` keys, with the deprecated `ULTIV_*`
  fallback (one warning per key).
- `node-version.ts` — `nodeVersionProblem`: the server, CLI and node agent
  refuse a Node older than 26 at boot.

Rules for this package: no domain knowledge (conversations, connectors — that
belongs above), no runtime deps beyond `effect`.

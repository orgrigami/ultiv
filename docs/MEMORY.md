# Memory v2

Status: implemented (2026-10-28). This is the contract for the memory faculty
described in RFC 0001 §9 — now shipped. Storage stays pi-durable docs in
`var/harness.sqlite`; no graph database, no paid service.

## Tiers

| Tier      | Doc kind              | Holds                                                                     |
| --------- | --------------------- | ------------------------------------------------------------------------- |
| Core      | `ultiv.mem.core`      | The always-on block, its own prompt section (`memory_core`)               |
| Facts     | `ultiv.mem.facts`     | Current, superseded and forgotten facts — the unit of memory              |
| Graph     | `ultiv.mem.graph`     | Entities (people, pets, places, projects); edges are the triples on facts |
| Episodes  | `ultiv.mem.episodes`  | Where facts came from; ring of 1,000 full inputs, never prompted          |
| Archive   | `ultiv.mem.archive`   | Cold facts, still searchable on demand                                    |
| Proposals | `ultiv.mem.proposals` | Tidy suggestions; nothing changes until the owner accepts                 |

The stored record names keep the `ultiv.` prefix from before the product was
renamed to Spreissen. They are internal storage names, not branding, and
renaming them would mean migrating the owner's data, so they stay.

All are `scope: "session"`, family docs keyed `owner:<o>` (owner store) or
`profile:<o>:<id>` (a bot's own store). Bots never see a sibling's store.

## Facts

Every fact carries: text (≤1,000 chars, stored in the language it was said
in), a kind (`fact|preference|instruction|event|note`), tags, entity ids, an
optional `(s, p, o)` triple, importance 1–5, confidence 0–1, trust
(`owner|self|derived|untrusted`), a full source stamp (via, writer, origin,
conversation, episode), a world-time validity interval (`validFrom`/
`validTo`) plus system times (`createdAt`/`confirmedAt`/`expiredAt`), a
status (`current|superseded|archived|forgotten`), supersede links
(`supersededBy`/`supersedes`) and a sha1 hash for exact dedupe.

Nothing is ever deleted except by **Purge** (owner-only, irreversible):
`memory_forget` makes a restorable tombstone; supersede and refine create new
versions and keep the history.

## Recall

Bilingual EN/ID: NFKD + diacritic stripping + `'s` fold, EN+ID stop words,
light stemming, and a data-driven synonym lexicon (~150 groups: cat/kucing,
birthday/ultah) that folds terms into shared `§concept` tokens on both the
index and the query side. Four candidate lists fuse by Reciprocal Rank
Fusion (k=60): L1 BM25 (k1 1.2, b 0.75; text ×1, tags ×2, entity names ×2,
top 50), L2 entity-linked facts (top 30), L3 1-hop graph neighbours (top 20),
L4 importance × recency prior `exp(-ageDays/180)` — a prior over candidates,
never a candidate source. Trust ×0.7 for untrusted; profile facts win ties;
results under 0.5× the top score drop; default limit 10 (max 25); output
budget 600 tokens (max 1,500). History (superseded/archived) surfaces only
on `includeHistory` or history words ("dulu", "used to", "riwayat"), grouped
under the current successor. The index is in-process behind a `MemoryIndex`
interface — an SQLite FTS5 sidecar can replace it past ~20k facts per store.
Embeddings are off (`MEMORY_EMBEDDINGS`); if ever on, prefer local Ollama.

## Writes

Pipeline: **guard → extract → resolve entities → decide → apply** (one
`docs.commit` transaction that re-reads inside the lock).

- **Guard** (`memory/guard.ts`): origin from the last admitted input's
  bracket prefix (`[cron …]`, `[webhook …]`, `[sensor …]`, `[message from …]`,
  `[task …]` = automated; a plain message or `[owner]` = the owner; anything
  else unknown). A turn that ran an untrusted-content tool (`web_fetch`,
  `web_search`, `http_request`, `room`, mail/calendar reads, MCP tools) is
  tainted. Owner+untainted → trust up to owner; owner+tainted → derived, no
  instructions unless the text appears in the owner's own words; cron/task →
  self, no instructions; webhook/sensor/bot/unknown → untrusted, profile
  scope only. Secrets (API keys, JWTs, private keys, Luhn-valid cards, NIK,
  OTPs) are refused with `vault:<item>` pointer advice.
- **Extract** (`memory/extract.ts`): one structured completion (2048 tokens,
  WIB date, ≤30 known entity names) with a deterministic fallback
  (`MEMORY_EXTRACT=off` or any model failure). Writes never block on the
  model.
- **Decide** (`memory/decide.ts`), first match wins:
  1. exact hash duplicate → noop (bump `confirmedAt`, merge tags)
  2. near-duplicate (Jaccard ≥ 0.85, same entities) → noop
  3. functional predicate, same subject, new object → supersede
  4. explicit `replaces` → supersede (or refine when similar)
  5. nothing similar (score < 0.35) → add
  6. ambiguous → Jev `pick`, else generate — failure/8 s → add + merge
     proposal.
- **Limits:** soft 3,000 current facts per store (tidy proposes archives);
  hard 10,000 refuses only low-importance (≤2) bot writes — "memory is full;
  ask Harry to review the tidy list". Owner and importance ≥3 writes land.

## Tools

- `memory_recall` — `query?`, `about?`, `includeHistory?`, `limit?`,
  `budgetTokens?`; ranked, bilingual, budgeted.
- `memory_write` — adds `kind?`, `importance?`, `basis`
  (`owner_said|observed|inferred`), `replaces?`, `validFrom?`; returns
  `{id, op, replaced?, entities}`.
- `memory_forget` — `id`, `reason`; a restorable tombstone, own writable
  scope only; owner-trust facts only when the owner asked that turn.
- `memory_related` — `entity`, `depth` 1–2; the entity card: current facts
  and graph neighbours.
- `memory_history` — `id`; the version chain with validity, change type and
  source.
- `memory_core` — add / replace / remove / list core lines, returns words
  remaining. Owner scope is keeper-only; bots cannot edit pinned lines.

Profiles with `memory_recall`/`memory_write` in their allowlist get the new
tools automatically (implied allowlist).

## Core memory

Owner core ≤120 words (≤10 lines, ≤25 words per line), shared by all bots,
written by the keeper or a human. Profile core ≤80 words (≤8 lines) per bot,
written by that bot or a human. Seeded only from profile settings (time
zone), never from model output. Rendered as the `memory_core` prompt section
after identity, capped at 230 words — data, framed as the owner's standing
facts, never model instructions.

## Weekly tidy

`apps/server/src/memory-tidy.ts`, croner Sundays 09:00 WIB
(`MEMORY_TIDY_CRON=0 9 * * 0`), not a bot turn, costs no tokens. Receipts
into `ultiv.routine-events`; catches up on boot after 8+ days; manual run
`POST /api/memory/tidy/run`. Deterministic detectors: stale, merge (exact
hash dups), secret, core-fix, plus deterministic entity backfill (20 facts
per run). Output: proposals (≤50 open, expire after 30 days, rejected
fingerprints never return), a push "Memory tidy: N suggestions" (no fact
text) and the badge in the Memory panel. **Nothing changes without the
owner's accept** — accept/reject is `POST /api/memory/v2/proposals/:id/accept|reject`.

## REST (owner surface)

- `GET /api/memory/v2?profile=<id|owner>` — facts, entities, core, proposals
- `POST /api/memory/v2/core[?profile=]` / `PATCH|DELETE /api/memory/v2/core/:lineId`
- `DELETE /api/memory/v2/facts/:factId[?profile=]` — the owner's tombstone
- `POST /api/memory/v2/facts/:factId/restore[?profile=]` — undo a tombstone
  (the Memory panel's Forgotten list)
- `POST /api/memory/v2/proposals/:id/accept|reject[?profile=]`
- `POST /api/memory/tidy/run`
- `POST /api/memory/purge[?profile=]` — irreversible: forgotten facts lose
  their text

The web Memory panel (per bot, "What X remembers") renders core lines, facts
and tidy suggestions at 390 px.

## Migration and rollback

The v1 → v2 migration is REMOVED (2026-10-28, owner-approved end of the
soak): every live store had already migrated and verified, and the owner
confirmed there is nothing left to migrate. Writes are v2-only; the old
`POST /api/memory/v1/cleanup` sweep is gone with it. The v1
`ultiv.memory` doc family stays exported only for the rollback surfaces.

- Rollback: `SPREISSEN_MEMORY_V2=off` brings back the v1 code path. This is
  a fallback for the v2 seam, not a full return to v1 — facts written
  while off land in the v1 docs and do not appear in v2 reads.
- Mirror: REMOVED 2026-10-28 (owner-approved end of the 14-day soak, commit
  of that date). Writes are v2-only; `POST /api/memory/v1/cleanup` swept the
  mirrored v1 `ultiv.memory` docs (only stores whose migration had verified).
  The v1 doc family stays as REST-compatible stubs.

## Flags

| Flag                  | Default     | Effect                                        |
| --------------------- | ----------- | --------------------------------------------- |
| `SPREISSEN_MEMORY_V2` | on          | `off` = v1-seam fallback, NOT a full rollback |
| `MEMORY_EXTRACT`      | on          | `off` = deterministic extraction only         |
| `MEMORY_EMBEDDINGS`   | off         | embeddings; prefer local Ollama if ever on    |
| `MEMORY_TIDY_CRON`    | `0 9 * * 0` | tidy schedule (croner, Asia/Jakarta)          |

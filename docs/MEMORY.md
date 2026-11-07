# Memory v3

Status: implemented (2026-11-04), on top of v2 (2026-10-28). This is the
contract for the memory faculty described in RFC 0001 §9. The truth stays
pi-durable docs in `var/harness.sqlite`; a derived search sidecar
(`var/search.sqlite`, see [Search sidecar](#search-sidecar)) indexes facts
and conversations for full-text search. No graph database, no paid service,
no network unless the optional local embedding model is turned on.

What v3 changed, in one list: model-visible fact handles; `memory_update`
(change / correct / end / confirm) for bots and the owner; end dates and
"as of" recall; recall before each turn; full-text recall through FTS5;
full-text search of each bot's conversations (tool, REST, Past chats);
contradiction and soft-limit proposals in the tidy; the write decision
moved outside the global commit lock; "learned in" provenance; an optional
meaning leg from a local embedding model.

## Tiers

| Tier      | Doc kind              | Holds                                                                     |
| --------- | --------------------- | ------------------------------------------------------------------------- |
| Core      | `ultiv.mem.core`      | The always-on block, its own prompt section (`memory_core`)               |
| Facts     | `ultiv.mem.facts`     | Current, superseded, archived and forgotten facts — the unit of memory    |
| Graph     | `ultiv.mem.graph`     | Entities (people, pets, places, projects); edges are the triples on facts |
| Episodes  | `ultiv.mem.episodes`  | Where facts came from; ring of 1,000 write inputs, never prompted         |
| Proposals | `ultiv.mem.proposals` | Tidy suggestions; nothing changes until the owner accepts                 |

Archived facts keep living in the facts doc with status `archived` (out of
recall, still history). The `ultiv.mem.archive` doc family exists but is
unused; nothing writes it.

The stored record names keep the `ultiv.` prefix from before the product was
renamed to Spriessen. They are internal storage names, not branding, and
renaming them would mean migrating the owner's data, so they stay.

All are `scope: "session"`, family docs keyed `owner:<o>` (owner store),
`profile:<o>:<id>` (a bot's own store) or `team:<o>:<id>` (a team's
shared store). Bots never see a sibling's store.

## Facts

Every fact carries: text (≤1,000 chars, stored in the language it was said
in), a kind (`fact|preference|instruction|event|note`), tags, entity ids, an
optional `(s, p, o)` triple, importance 1–5, confidence 0–1, trust
(`owner|self|derived|untrusted`), a full source stamp (via, writer, origin,
conversation, episode — the episode is linked since v3), a world-time
validity interval (`validFrom`/`validTo`) plus system times
(`createdAt`/`confirmedAt`/`expiredAt`), a status
(`current|superseded|archived|forgotten`), supersede links
(`supersededBy`/`supersedes`) and a sha1 hash for exact dedupe. Since v3,
optionally: `basis` (`owner_said|observed|inferred|confirmed`), `retired`
(why a version left the present: `changed|corrected|ended`) and
`confirmations` (times the owner confirmed it). Facts written before v3
have none of the three and read as before.

Nothing is ever deleted except by **Purge** (owner-only, irreversible):
`memory_forget` makes a restorable tombstone; change, correct and end keep
the history.

### Handles

The harness never shows a tool's structured output to the model, so every
model-facing memory line leads with a **handle**: `#` and the fact id's
first 8 characters (`#1a2b3c4d`). Every tool that takes a fact id —
`memory_update`, `memory_forget`, `memory_history`, `memory_write`'s
`replaces` — resolves a handle, a unique prefix of 6+ characters or the
full id, and refuses an unknown or ambiguous one with a sentence the model
can act on (`memory/handles.ts`). The owner's web views strip handles.

### Lifecycle

| Act                | What happens                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `change`           | A new version holds; the old one is `superseded`, `retired: "changed"`, `validTo` = the new version's start (the past)                                                               |
| `correct`          | The old version was wrong: `retired: "corrected"`, never offered again (not even as history); the fix holds from the old start                                                       |
| `end`              | It stops holding with nothing in its place: from today it retires (`retired: "ended"`); with a future day it stays current until then, shown as "until …", and recall drops it after |
| `confirm`          | The owner said it again or agreed: `confirmedAt` now, confidence ≥ 0.9, `confirmations` +1, `inferred` → `confirmed`; only a clean owner turn may                                    |
| `forget` / restore | A restorable tombstone / the owner's undo                                                                                                                                            |

Authority follows the forget rule (`memory/lifecycle.ts`): a bot changes,
corrects or ends an owner-stated fact only when the owner asked in that very
turn, untainted. Dates are calendar days, `YYYY-MM-DD` in the bot's zone
(WIB by default), or ISO times (`memory/dates.ts`); epoch milliseconds
still parse for older callers.

## Recall

Bilingual EN/ID analysis (unchanged from v2): NFKD + diacritic stripping +
`'s` fold, EN+ID stop words, light stemming, and a data-driven synonym
lexicon (~150 groups: cat/kucing, birthday/ultah) that folds terms into
shared concept tokens on both the index and the query side.

Candidate lists fuse by Reciprocal Rank Fusion (k=60):

| Leg                | Weight | Source                                                                                                            |
| ------------------ | -----: | ----------------------------------------------------------------------------------------------------------------- |
| Words (BM25)       |    1.0 | FTS5 over the analyzed terms: text ×1, tags ×2, entity names ×2, synonym concepts ×0.8; top 50                    |
| Entities named     |    0.8 | Facts linked to entities whose name or alias is in the query; top 30                                              |
| Meaning (optional) |    0.8 | Cosine over local-model embeddings, ≥ 0.3; see [Meaning leg](#meaning-leg-optional)                               |
| Graph neighbours   |    0.5 | 1-hop entities through fact triples; top 20                                                                       |
| Letters (trigram)  |    0.3 | FTS5 trigram overlap — a slip, a code inside a word; finds on its own only when the other legs found fewer than 3 |
| Prior              |    0.3 | importance × `exp(-age/180 days)` — a prior over candidates, never a source                                       |

Then: trust ×0.7 for untrusted; profile facts win ties; results under 0.5×
the top score drop; default limit 10 (max 25); output budget 600 tokens
(max 1,500). Corrected versions never surface; non-owner instruction facts
never surface; a current fact whose `validTo` has passed reads as history.
History (superseded/archived) surfaces only on `includeHistory` or history
words ("dulu", "used to", "riwayat"), grouped under the current successor.
`asOf` (a day) answers "what held then": every version valid at the end of
that day, current or since changed/ended, never corrected or forgotten.

Each line: `#handle text (since … · until … · confirmed … · inferred,
unconfirmed | unverified, from …)`. Without the sidecar (it failed to open)
the in-process BM25 index serves the word leg, cached per pool.

### Recall before each turn

A bot no longer has to remember to remember. The `recalled_memories`
prompt section (`memory/prefetch.ts`, `prefetch-section.ts`) renders before every
model request; for the conversation's latest input (once per input, cached
across the turn's tool rounds) it recalls, gates and shows the memories the
message is about, as data with their handles. The gate (after
[hermes-plugin-holographic](https://github.com/itpartypattaya/hermes-plugin-holographic)'s
prefetch, MIT, reimplemented):

- a fact passes when it covers ≥ 30% of the message's words that memory
  knows, each weighted by its rarity in the bot's memory;
- a fact sharing a single word passes only when the word is distinctive (no
  other fact holds it) or may be a name (capitalized mid-sentence);
- up to two facts about an entity the message names pass besides;
- at most 5 facts within ~300 tokens, whole lines only; "ok, thanks"
  recalls nothing.

Sections are written into the transcript and stay in context, so a fact
shown for one of the last 6 inputs is not shown again. `MEMORY_PREFETCH=off`
turns the section off.

## Writes

Pipeline: **guard → extract → resolve entities → decide → apply**.

- **Guard** (`memory/guard.ts`): origin from the last admitted input's
  bracket prefix (`[cron …]`, `[webhook …]`, `[sensor …]`, `[message from …]`,
  `[task …]` = automated; a plain message or `[owner]` = the owner; anything
  else unknown). A turn that ran an untrusted-content tool (`web_fetch`,
  `web_search`, `http_request`, `room`, mail/calendar reads, MCP tools) is
  tainted; the check reads that conversation's own audit trail
  (`audit.ofConversation`), so other bots' traffic can never push the call
  out of view. Owner+untainted → trust up to owner; owner+tainted → derived, no
  instructions unless the text appears in the owner's own words; cron/task →
  self, no instructions; webhook/sensor/bot/unknown → untrusted, profile
  scope only. Secrets (API keys, JWTs, private keys, Luhn-valid cards, NIK,
  OTPs) are refused with `vault:<item>` pointer advice. `memory_write` and
  `memory_update` share this guarded path (`memory/tools-write.ts`).
- **Extract** (`memory/extract.ts`): one structured completion (2048 tokens,
  WIB date, ≤30 known entity names) with a deterministic fallback
  (`MEMORY_EXTRACT=off` or any model failure). The prompt names the
  functional predicate vocabulary, and triples are normalized on the way in
  (`memory/predicates.ts`: EN/ID synonyms fold onto `lives_in`, `works_at`,
  `role_is`, `name_is`, `birthday_on`, `born_on`, `spouse_of`,
  `timezone_is`, `status_is`, `located_in`). The fallback's entity guesses
  skip sentence-opening function words and days/months.
- **Decide** (`memory/decide.ts`), first match wins:
  1. exact hash duplicate → noop (bump `confirmedAt`, merge tags)
  2. near-duplicate (Jaccard ≥ 0.85, same entities) → noop
  3. functional predicate, same subject (case/accent-blind), new object →
     supersede
  4. explicit `replaces` (a handle) → supersede (or refine when similar)
  5. nothing similar (score < 0.35) → add
  6. ambiguous → Jev `pick`, else generate — failure/8 s → add + merge
     proposal.
- **The lock:** `docs.commit` is ONE lock for every durable write in the
  app, chat admission included. The decision (which may ask Jev or a model
  for 8 s) runs on a snapshot BEFORE the commit; inside it the store is
  re-read and, if a write landed meanwhile, re-decided by the rules alone
  (an ambiguous case then adds and leaves a merge proposal).
- **Limits:** soft 3,000 current facts per store (the tidy proposes
  archives); hard 10,000 refuses only low-importance (≤2) bot writes —
  "memory is full; ask the owner to review the tidy suggestions". Owner and
  importance ≥3 writes land.

## Tools

- `memory_recall` — `query?`, `about?`, `includeHistory?`, `asOf?` (a day),
  `limit?`, `budgetTokens?`; ranked, bilingual, budgeted; lines lead with
  handles.
- `memory_write` — `text`, `kind?`, `importance?`, `basis`
  (`owner_said|observed|inferred`), `replaces?` (a handle), `validFrom?` and
  `validTo?` (days), `tags?`, `scope?`, `share?`; answers
  `remembered #handle (op…)`.
- `memory_update` — `id` (a handle), `op` (`change|correct|end|confirm`),
  `text?` (change/correct), `at?` (a day: change's start, end's day).
- `memory_forget` — `id`, `reason`; a restorable tombstone, own writable
  scope only; owner-trust facts only when the owner asked that turn.
- `memory_related` — `entity`, `depth` 1–2; the entity card: current facts
  (with handles) and graph neighbours.
- `memory_history` — `id`; the version chain with days, change type
  (`created|refined|superseded|corrected|ended|forgotten`) and source.
- `memory_core` — add / replace / remove / list core lines, returns words
  remaining. Owner scope is keeper-only; bots cannot edit pinned lines.
- `history_search` — see [Conversation search](#conversation-search).

The memory tools are faculty tools: every bot has them, whatever its
allowlist.

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
`POST /api/memory/tidy/run`. Deterministic detectors:

- **conflict** (`memory/conflicts.ts`, after holographic's `contradict`,
  MIT, reimplemented): the same functional relation of the same subject
  with another value, or facts sharing entities (overlap ≥ 0.3) whose
  claims — words minus the entity names — overlap 0.3–0.85 where neither
  only adds detail to the other. Proposed as `[older, newer]`; accepting
  keeps the newer and retires the older as changed (nothing forgotten).
- **stale** (unconfirmed 6+ months, importance ≤2, not the owner's word),
  **archive** (past the soft limit: the least valuable, ten per run),
  **merge** (exact hash dups), **secret**, **core-fix**, plus deterministic
  entity backfill (20 facts per run).

Output: proposals (≤50 open, expire after 30 days, rejected fingerprints
never return), a push "Memory tidy: N suggestions" (no fact text) that opens
Needs you, and the badge in the Memory panel. **Nothing changes without the
owner's accept** — `POST /api/memory/v2/proposals/:id/accept|reject`.

## Search sidecar

`packages/mind/src/search/`: one SQLite file through Node's built-in
`node:sqlite` (FTS5, no extension, no dependency). `SEARCH_DB`, default
`var/search.sqlite`; a mind opened on injected test storage keeps it in
memory. It is **derived**: the docs and transcripts stay the truth, a schema
change rebuilds it (`SEARCH_SCHEMA_VERSION`), and deleting the file only
costs a re-index.

- **Facts** (`search/facts.ts`): a store syncs by per-fact signature (text
  hash, tags, entity names) before each recall — only changed facts are
  rewritten; a purge drops the store's rows at once.
- **Messages** (`search/messages.ts`): see below.
- Two FTS5 tables per corpus: `*_terms` (our analysis written as plain
  tokens, concepts as `zc…` tokens, `unicode61`) and `*_grams` (raw text,
  `trigram`). Queries are built from the same analysis and always quoted —
  no user text is FTS5 syntax.

## Conversation search

Every message of a bot's chats — the owner's input, the bot's reply text
(never its thinking), tool results (first 2,000 characters) — is indexed
verbatim, **per bot**: rows carry the owner and the profile and every query
filters on both, so a bot (and the owner's view of it) only ever searches
that bot's chats. System and section entries, compaction summaries and
bookkeeping are not messages.

- Indexing is incremental by entry-id cursor per conversation and runs
  before each search (never stale); chats that left the bot's list (deleted
  chats) and purged bots drop their rows. A minute after boot the server
  indexes each bot's chats once (`SEARCH_WARMUP_MS`), so the first search on
  a long history does not wait.
- Ranking: BM25 over the bilingual analysis, trigram overlap (on its own
  only when words found little), the meaning leg when configured, and a
  light recency prior.
- **Time phrases** (`search/when.ts`): yesterday/kemarin, today/hari ini,
  N days ago/N hari lalu, this/last week (minggu ini/lalu), this/last month
  (bulan ini/lalu), and a month with a preposition or a year ("in March",
  "pada maret", "maret 2026") narrow the window; the phrase leaves the
  words. A bare month word ("may I") is not a date.
- **Tool:** `history_search` — `query`, `since?`/`until?` (days), `who?`
  (`owner|you|tool`), `limit?`; readable lines with day, speaker and chat.
- **Owner:** `GET /api/history/search?q=&bot=&since=&until=&who=&limit=` —
  one bot, or each of the owner's bots grouped (another owner's bot answers
  404); Past chats shows a Messages section under its filter from two
  letters on, hits highlighted and grouped by bot, each opening its chat.

Without the sidecar the tool falls back to a substring scan of recent chats.

## Meaning leg (optional)

Off by default. `MEMORY_EMBEDDINGS` picks where embeddings come from
(`search/embedders.ts`):

| Value                | Endpoint                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ollama`             | A local Ollama: `OLLAMA_URL` (default `http://127.0.0.1:11434`), `EMBEDDING_MODEL` (default `embeddinggemma`)                                                                                                                                                                                                                                                                                                                          |
| `<provider>/<model>` | Any model-catalog provider with an embedding API, through the endpoint and key its chat models use (`providers/embedding-endpoint.ts`): OpenAI-compatible gateways (e.g. `kenari/bge-m3`, `kenari/text-embedding-3-small`, `openrouter/…`, Together, DeepInfra, a keyless local server listed in `SPRIESSEN_PROVIDERS`), `openai/…`, `mistral/mistral-embed`, `google/…` (its OpenAI-compatible path). Anthropic has no embedding API. |
| `openai-compatible`  | Any OpenAI-shaped `/embeddings` endpoint: `EMBEDDING_URL` (its base, e.g. `http://127.0.0.1:1234/v1` for LM Studio), `EMBEDDING_MODEL`, optional `EMBEDDING_API_KEY`                                                                                                                                                                                                                                                                   |

Kenari serves embeddings without listing them in `/v1/models`; at the time
of writing: `bge-m3` (1024 dims, multilingual — a good fit for EN/ID),
`text-embedding-3-small`/`-large`, `mistral-embed`, `codestral-embed`,
`qwen3-embedding-0.6b`.

Facts and messages are embedded lazily (64 per search), stored as float32
blobs keyed by model (a new model re-embeds instead of mixing spaces),
dropped with the text they belong to, and searched by an exact cosine
scan. The cutoff adapts to the model: a row counts when it is at least
halfway from the scan's median similarity to its top (never below 0.3) —
unrelated texts score ~0.05 on OpenAI's small model but ~0.37 on bge-m3. The
leg joins fact recall and conversation search and finds on its own.

**Remote endpoints** (anything outside loopback, private ranges, the
tailnet and `.local`) are sent facts and messages but never tool results —
pages, mail and files a bot read stay on the machine;
`EMBEDDING_INCLUDE_TOOLS=on` overrides. Any failure (no server, a bad key,
a timeout) drops the leg for that search — words carry on — and is logged
at most once per ten minutes. Settings › Server shows the model, whether it
is remote, and its last success or error (`GET /api/server/check`,
`mind.meaning()`); a key is never shown. Changing the setting takes effect
at the next server start.

## REST (owner surface)

- `GET /api/memory/v2?profile=<id|owner>` — facts, entities, core,
  proposals, and the bot's chats by conversation id (`chats`, for "Learned
  in …")
- `POST /api/memory/v2/facts/:id/update[?profile=]` — `{ op, text?, at? }`:
  the owner's change / correct / end / confirm (audited as
  `memory.fact.<op>`)
- `POST /api/memory/v2/core[?profile=]` / `PATCH|DELETE /api/memory/v2/core/:lineId`
- `DELETE /api/memory/v2/facts/:factId[?profile=]` — the owner's tombstone
- `POST /api/memory/v2/facts/:factId/restore[?profile=]` — undo a tombstone
- `POST /api/memory/v2/proposals/:id/accept|reject[?profile=]`
- `POST /api/memory/tidy/run`
- `POST /api/memory/purge[?profile=]` — irreversible: forgotten facts lose
  their text (and leave the search sidecar)
- `GET /api/history/search` — see [Conversation search](#conversation-search)

The web Memory panel (per bot, "What X remembers") renders core lines, facts
and tidy suggestions. A fact row offers "It changed", "It was wrong", "No
longer true" and Confirm (on the bot's unconfirmed guesses), shows a known
end day, and links "Learned in …" to the chat it came from.

## Migration and rollback

- v3 needs no migration: its fields are optional, older facts read as
  before, and the sidecar builds itself on first use.
- Rollback: `SPRIESSEN_MEMORY_V2=off` brings back the v1 code path. This is
  a fallback for the v2 seam, not a full return to v1 — facts written
  while off land in the v1 docs and do not appear in v2 reads.
- The v1 → v2 migration and mirror are REMOVED (2026-10-28): nothing was left
  to migrate. The v1 `ultiv.memory` doc family stays as REST-compatible
  stubs.

## Flags

| Flag                      | Default                  | Effect                                                                 |
| ------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `SPRIESSEN_MEMORY_V2`     | on                       | `off` = v1-seam fallback, NOT a full rollback                          |
| `MEMORY_EXTRACT`          | on                       | `off` = deterministic extraction only                                  |
| `MEMORY_PREFETCH`         | on                       | `off` = no recall before each turn                                     |
| `MEMORY_EMBEDDINGS`       | off                      | `ollama`, `<provider>/<model>` or `openai-compatible`: the meaning leg |
| `OLLAMA_URL`              | `http://127.0.0.1:11434` | the Ollama endpoint (`ollama`)                                         |
| `EMBEDDING_MODEL`         | `embeddinggemma`         | the model (`ollama`, `openai-compatible`)                              |
| `EMBEDDING_URL`           | —                        | the base URL (`openai-compatible`)                                     |
| `EMBEDDING_API_KEY`       | —                        | its key, if it needs one (`openai-compatible`)                         |
| `EMBEDDING_INCLUDE_TOOLS` | off                      | `on` = send tool results to a remote model too                         |
| `SEARCH_DB`               | `var/search.sqlite`      | the search sidecar (derived, rebuildable)                              |
| `SEARCH_WARMUP_MS`        | `60000`                  | when the boot indexing of conversations runs                           |
| `MEMORY_TIDY_CRON`        | `0 9 * * 0`              | tidy schedule (croner, Asia/Jakarta)                                   |

## Credits

The recall-before-turn gate and the contradiction detector follow
[hermes-plugin-holographic](https://github.com/itpartypattaya/hermes-plugin-holographic)
(MIT), reimplemented here without its code; its HRR vectors were measured as
a hashed bag of words (0.96 correlation with word overlap) and not adopted.
Time-aware search follows LongMemEval's findings; the verbatim,
per-message history index and the meaning leg follow mempalace's benchmark
(MIT); invalidation instead of deletion follows Zep/Graphiti.

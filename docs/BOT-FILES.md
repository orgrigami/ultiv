# BOT-FILES.md: Persona and Instructions

Each bot has two plain-text files the owner can read and edit. Memory and
skills don't change.

## The two files

- **Persona**: who the bot is. Its identity, tone and style.
- **Instructions**: what the bot does. Its rules, workflows and when to ask
  first.

Both are plain text. Markdown is allowed. There's no frontmatter and no
schema. Persona holds up to 8,000 characters and Instructions up to 16,000.

## Where they live

`{BOT_FILES_DIR}/{owner}/{profile}/persona.versions.json` and
`instructions.versions.json` hold the files. `BOT_FILES_DIR` defaults to
`var/bot-files`, relative to the server's cwd like `ARTIFACTS_DIR`. Each
file is the full version list, and the last entry is the current text.
Paths go through the shared confinement helper (`resolveInside` in
`@spriessen/core`). Writes go to a temp file and are renamed into place,
so a crash never leaves a half-written file.

## Versions

- Every save creates a version with its number, the time, who or what saved
  it (`owner`, `bot`, `migration`, `learning`), and a one-line reason.
  Skill versions can also record the turn they came from.
- A save that leaves the text unchanged creates no version. The only
  exception is a restore.
- Restore creates a new version that copies the old one and records
  `restoredFrom`. History is never rewritten or pruned.
- Skills use the same version store (`packages/mind/src/versions/store.ts`).
  It lives beside the skill store, under `{SKILLS_DIR}/{owner}/{profile}/versions/`.

## Prompt order

Every request's system prompt is built in this order:

1. The identity section (`ultiv.profiles`, key `identity`): who the bot is
   and its role, then **Persona**, then **Instructions**, then the owner's
   time zone, the identity line, the voice and the operating rules, then
   the sibling roster.
2. Core memory (`memory_core`), the same as today.
3. The skills index (`skills`), the same as today.
4. The other sections (connectors, running tasks), in install order.
5. Then the chat.

Memory still comes before skills, as it did before.

## Instructions and approval rules (D7)

"When to ask first" lives in two places:

- as text in Instructions, which the bot reads and follows;
- as approval rules (the approval mode and always-allow rules), which the
  approval broker enforces.

When they conflict, the approval rules win because they're enforced.
Instructions text can never loosen an approval rule or change the approval
mode. The broker reads only the bot's `policies`, never the files. The
prompt says so next to the Instructions.

## Migration from the old persona field

- At boot, and the first time a bot's files are read, a bot with no
  Persona file gets one with its current `persona` field as version 1
  (by `migration`). Instructions starts as an empty version 1, because
  the old field can't be split into the two safely.
- The migration is repeatable. A bot that already has a file is skipped,
  so running it twice changes nothing.
- The old field stays readable for one release. Every Persona save also
  writes `persona` on the profile row, so the field always holds the
  current Persona text.
- **Rollback:** revert the code. The `persona` field is current, so
  nothing is lost except Instructions text. To run the migration again,
  stop the server, delete `BOT_FILES_DIR`, and start it again.

## Owner surface

- `GET /api/profiles/:id/files` returns both files and their current
  versions.
- `GET /api/profiles/:id/files/:file/versions` returns the history.
- `PUT /api/profiles/:id/files/:file` with `{ text, reason? }` saves a
  version.
- `POST /api/profiles/:id/files/:file/restore` with `{ version }` restores
  one.

All of these are owner-scoped. Another owner's bot gets the same 404 that
an unknown bot gets. On the profile page, the Instructions tab edits both
files, lists versions newest first, and restores any older one. The
Overview's Details show both files.

## Code structure tools

Bots that work on code in their own file tree have two read tools, both
open (no approval) and parsed with tree-sitter (WASM, loaded lazily — no
daemons, no native deps). Supported languages: TypeScript, TSX,
JavaScript and Python (by extension: `.ts` `.mts` `.cts` `.tsx` `.js`
`.mjs` `.cjs` `.jsx` `.py`). Everything else is a normal file with no
symbols.

- **`code_outline`** — an indented tree of the bot's files with the
  symbols in each code file (`fn greet:1`, `class Greeter:5`,
  `method greet:6`, `const add:9`, `type Label:11`,
  `interface Named:13`). Params: `path` (optional folder scope) and
  `depth` (1–6, default 4). At most 30 symbols per file; output is
  capped at ~6,000 characters and ends with
  `(truncated — narrow with path or depth)` when cut. Dependency and
  build folders are never listed: `node_modules`, `.git`, `dist`,
  `build`, `__pycache__`, `.venv`, `venv`, `.coverage`, `.worktrees`,
  `.next`.
- **`code_nav`** — where a name lives. `definitions` lists declarations
  (`file:line  kind name` plus the source line); `references` lists
  every identifier occurrence in code — strings and comments are
  excluded, by node type, not by regex. Params: `action`, `name`,
  optional `path` scope. At most 50 hits; the result ends with a count
  line, and a scope with no parseable code is a plain answer, not an
  error.

Both tools cover their scope: every result starts with
`scope: <path> (N file(s), M parsed)`. Paths are workspace-relative,
exactly like the other file tools (bash shows the same tree as `/home`),
with the same refusals: a chat with no bot, `..`, absolute paths and
symlinks.

- **`file_find`** — find files by name pattern: a glob (`*.py`,
  `report*`, `src/**/*.md`; `*` stays in one path segment, `**` crosses
  folders, `?` is one character, no new dependency). `path` scopes the
  search to one folder. Patterns with a `/` match whole relative paths,
  plain patterns match file names. The same build/dependency folders are
  skipped, output is capped at 100 paths, and the last line counts the
  matches.

**file_edit syntax notes.** After a successful write to a supported
code file (up to 300 KB), the result appends
`note: N syntax error(s) detected, first at line L` when the parse has
error nodes. A clean parse, an unsupported language or a bigger file
adds nothing — the ordinary result line stays exact.

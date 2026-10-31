# SKILLS.md

Skills are packaged procedures: a SKILL.md (agentskills.io frontmatter:
`name`, `description`) plus optional reference files, kept per bot. They
are the procedural tier above memory: memory holds facts that are true,
skills hold ways of working worth loading before similar work.

## Where they live

- Built-ins: `packages/about`, the app's own self-knowledge as one
  whole-world skill (`spreissen`): a lean SKILL.md (ground truths, owner
  experience, the reference index) plus `references/` for the surfaces,
  the faculties, the procedures, and the platform contracts. Read-only,
  updated with the app; built-in files read from the package, never disk.
- Per-bot: `{SKILLS_DIR}/{owner}/{profile}/skills/<name>/SKILL.md`
  (default `var/skills`), metadata in `skills.index.json` beside them.
  Every save also appends to the skill's full history in
  `versions/<name>.versions.json` (the version store Persona and
  Instructions use, docs/BOT-FILES.md): number, time, who (`owner`, `bot`,
  `learning`, `migration`), a one-line reason, and for bot writes the turn
  (`conversation#call`). Only SKILL.md is versioned; reference files are
  not. Restore and undo append a copy, so history is never rewritten; a
  removed skill's history stays, and a new skill by that name numbers on.
  A skill saved before full history shows its two known versions (the
  current one and the index's previous body) and keeps them on its next
  save. Reference
  files (`references/`, `scripts/`, `assets/`, any layout) live beside the
  SKILL.md and are listed in the metadata.
- Names and descriptions follow the agentskills.io spec: name matches the
  folder, 1-64 chars, lowercase alnum with single interior hyphens;
  description at most 1024 chars. The store normalizes the frontmatter
  name to the folder on write.
- Proposals: `skills.proposals.json` per profile; evolution runs and
  cautious bots park changes here instead of applying them.

## The trust model

Origin stamps every skill: `builtin`, `self` (the bot's own craft),
`owner` (written via REST), `url` (installed from outside). Self-authored
writes are open, like artifact writes: a bot growing its own craft in its
own namespace is what memory writes already are, one tier up. The closed
doors: built-ins refuse writes, deletes are gated like artifact deletes,
`skill_install` is gated EVERY time (the connector rule) and fetches
through the broker's SSRF guard, size-capped, https-only. Bodies that look
like they carry secrets (key-shaped patterns) are refused at the store.
Skill text reaches every enabled bot's context: the section says so, and
the review before enable is where trust gets granted.

## The prompt section

Each mapped conversation renders the floor line ("You live in Spreissen...")
plus up to 16 enabled skills (name + clipped description; `skill_list`
beyond), plus the trust rule. Sections re-render per request, so writes,
installs, disables and accepted proposals are live by the bot's next turn.

## Learning on its own

`skill_learn` (`packages/mind/src/skills/learn.ts`) is how a bot keeps what
a turn taught it without asking: a procedure it just worked out, or the
owner correcting how it does a thing. There's no approval card; the owner
sees "learned: <lesson>" in the chat with a one-tap Undo (only while that
version is still the newest; otherwise the bot's Skills page restores any
version). Undoing a skill the save created removes it; its history stays. Each save is a version by `learning`, with the turn
(`conversation#call`) and `learned: <lesson>` as its reason. The prompt
section carries the learning rule while learning is on.

Because it isn't gated, the refusals are the safety:

- the turn must be the owner's, a routine's or a task's; webhook, sensor,
  bot-to-bot and unknown turns are refused;
- nothing copied from outside content this turn: any 8-word run from a web
  page, search, request, mail, calendar, room, document
  (`extract_document_text`), file, artifact, history, skill file, shell
  output or MCP tool result, and any address, link, handle or long number
  from it that the owner didn't type themselves. If an outside tool ran but
  its result can't be read back, the save is refused (fails closed);
- nothing about approvals or permissions (approval modes, YOLO, always-allow,
  allowlists, "without asking"): those live in the owner's settings only;
- no secrets or vault values: key shapes, cards, IDs, codes, and any
  address, number or 4-word run a vault tool returned this turn;
- at most 3 learned saves a turn; built-ins can't be written;
- a per-bot switch, `policies.learnSkills` (default on; the bot page's
  Access tab, "Learns skills on its own"). Off refuses `skill_learn` and
  drops the rule from the prompt; the bot can still `skill_write` when asked.

No replay or evaluation runs on a learned save (`skill_evolve` is the
separate, explicit loop). Tests: `packages/mind/src/skills/learn.test.ts`
(including the planted-instruction case) and
`apps/server/src/rest/learn-switch.test.ts`.

## Evolution

`skill_evolve` runs the loop as a background task (the bot's own, so it
uses the bot's tools): reread the skill, mine its past runs through
`history_search`, write 3-6 eval cases, draft 3 candidates, judge them
(Jev `jev_rate` when configured, honest self-scoring otherwise), land the
winner. Mode `propose` (default) parks it for the owner; `apply` is for
when the owner asked directly. Semantic preservation is a Jev gate, the
diff is the proposal's note, and versions chain (`parentVersion`), so
nothing is lost. Built-ins never evolve: copy one first.

## Tools

| Tool            | Gate  | What it does                                                    |
| --------------- | ----- | --------------------------------------------------------------- |
| `skill_list`    | read  | full sheet: name, description, origin, version, enabled         |
| `skill_load`    | read  | full instructions into context; refuses disabled skills         |
| `skill_file`    | read  | one reference file inside a skill                               |
| `skill_write`   | open  | create or update; `files` sets the complete reference set       |
| `skill_learn`   | open  | save a lesson on its own, with the learning refusals above      |
| `skill_delete`  | gated | remove one of the bot's skills                                  |
| `skill_install` | gated | install from https: raw SKILL.md text or a .tar.gz skill folder |
| `skill_propose` | open  | park a change for the owner (proposals inbox)                   |
| `skill_evolve`  | open  | start the evolution task; `mode: propose\|apply`                |

## Owner surface

`GET /api/skills` returns `{ builtins, profiles, openProposals }`; detail,
PUT (body and/or `enabled`), DELETE, `GET .../versions` (newest first),
`POST .../restore` `{ version }`, `POST .../revert` (undo: the version
before the current one becomes current) and
`POST .../proposals/:id/accept|reject` are per-skill routes, all
owner-scoped (another owner gets the unknown-bot 404) and audited under
kind `skills`. The web page groups skills per bot, badges origin, renders
bodies, hosts the proposal inbox, and in each skill's dialog shows the
versions with Restore and an Undo button once there is a second version.

## Exposure (as of Phase 1)

- Per bot: every read and write takes `{owner}/{profile}` from the
  conversation's mapping (`skillsScope`), and paths go through
  `resolveInside`. A bot can't name another bot's skills.
- Fixed in slice 10: an absent `skills.index.json` used to return one
  shared empty object that writes then filled, so a bot with no index of
  its own listed (and on its next index write saved) another bot's skill
  names and descriptions, across owners too. Bodies never leaked: they're
  read from the bot's own folder. Listings now skip rows whose SKILL.md
  isn't in the bot's folder, which also hides rows copied in before the fix.
- Code: skill files (`scripts/` included) are text in the skill store and
  never run by the app. They are not in the bash tree; a bot can only run
  one by copying its text into its own files and running it in its
  sandboxed bash, like any text it can read.

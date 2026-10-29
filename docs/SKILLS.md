# SKILLS.md

Skills are packaged procedures: a SKILL.md (agentskills.io frontmatter:
`name`, `description`) plus optional reference files, kept per bot. They
are the procedural tier above memory: memory holds facts that are true,
skills hold ways of working worth loading before similar work.

## Where they live

- Built-ins: `packages/about`, the app's own self-knowledge (ultiv,
  surfaces, your-mind, procedures). Read-only, updated with the app.
- Per-bot: `{SKILLS_DIR}/{owner}/{profile}/skills/<name>/SKILL.md`
  (default `var/skills`), metadata in `skills.index.json` beside them,
  including the previous version's body for one-click revert.
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

Each mapped conversation renders the floor line ("You live in Ultiv...")
plus up to 16 enabled skills (name + clipped description; `skill_list`
beyond), plus the trust rule. Sections re-render per request, so writes,
installs, disables and accepted proposals are live by the bot's next turn.

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

| Tool            | Gate  | What it does                                            |
| --------------- | ----- | ------------------------------------------------------- |
| `skill_list`    | read  | full sheet: name, description, origin, version, enabled |
| `skill_load`    | read  | full instructions into context; refuses disabled skills |
| `skill_file`    | read  | one reference file inside a skill                       |
| `skill_write`   | open  | create or update in the bot's own namespace             |
| `skill_delete`  | gated | remove one of the bot's skills                          |
| `skill_install` | gated | install from a https URL serving raw SKILL.md text      |
| `skill_propose` | open  | park a change for the owner (proposals inbox)           |
| `skill_evolve`  | open  | start the evolution task; `mode: propose\|apply`        |

## Owner surface

`GET /api/skills` returns `{ builtins, profiles, openProposals }`; detail,
PUT (body and/or `enabled`), DELETE, `POST .../revert` and
`POST .../proposals/:id/accept|reject` are per-skill routes, all
owner-scoped and audited under kind `skills`. The web page groups skills
per bot, badges origin, renders bodies, and hosts the proposal inbox.

# dsh-superagent, mapped onto Spriessen

DeepSeek's [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)
(MIT, a research prototype for DeepSeek Harness) runs one proactive coding
agent for a team: it listens to GitHub and Feishu, admits requests through a
written Policy, works each one as a Ticket in its own session and directory,
and replies where the request was made. Its rule is **take as little human
attention as possible, and give as much value as possible.**

This page maps every concept of its numbered docs (000–008) onto Spriessen:
what Spriessen already had, what was built from it (November 2026), and what
does not apply, with the reason. Spriessen is single-owner and runs many
bots; dsh-superagent is one agent serving a team. Most differences follow
from that.

## Philosophy (000)

| dsh-superagent                                                 | In Spriessen                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Act only when asked or when a written rule allows it           | Bots act on the owner's messages and on routines the owner approved (`schedule_set`, `sensor_set`, `webhook_create` are gated). Outside senders are gated per webhook: **built**, `senders` (`packages/mind/src/webhooks/route.ts`). |
| Proactive work starts in a mode that only records              | **Built**: trial mode for schedules, watches and webhooks (`packages/mind/src/routines/trial.ts`, docs/ROUTINES.md).                                                                                                                 |
| Speak only when a person must act or can use a result          | **Built**: `[nothing to report]` quiet check-ins, no push (`packages/contracts/src/quiet.ts`). Already: `notify_owner` caps (2 min, 280 chars), push collapse and rate caps.                                                         |
| One concrete question at a time, in a structured form          | Already: `ask_user_question` (`packages/mind/src/ask/question.ts`), a card in the chat and Needs you, also from tasks.                                                                                                               |
| Report honestly: drafts unfinished, failures as failures       | Already: identity rules (`packages/mind/src/act/identity.ts`), `ownerErrorText`, failed tasks in Needs you.                                                                                                                          |
| A panel that shows only what needs a person                    | Already: Needs you (`apps/web/src/lib/needs-you.ts`).                                                                                                                                                                                |
| Setup by an agent, one question per message, no secret in chat | **Built**: `SETUP.md`.                                                                                                                                                                                                               |

## Domain (001) and authorization (002)

| dsh-superagent                           | In Spriessen                                                                                                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Source (a stream of events)              | Webhooks, cron, sensors (calendar, RSS, watched pages): docs/ROUTINES.md.                                                                                                                                                      |
| Trigger (one immutable event, receipted) | Write-ahead routine receipts (`ultiv.routine-events`), now with `trial` and `ignored` statuses.                                                                                                                                |
| Thread, Subscription, fan-out            | **Built**: webhook threads. A thread key opens one chat per outside thread and later payloads continue it (`packages/mind/src/webhooks/threads.ts`).                                                                           |
| Channel (reply where it was asked)       | Partly: a thread's chat is told to answer the outside thread through its API with a bound credential, and only when someone there must act (`webhook_create` description). A generic reply transport is not built (see below). |
| Policy: allowed lists per Source         | **Built** per webhook (`senders`). Strangers only add context-only notes to a thread that has a chat, and never open one.                                                                                                      |
| Gate strength (explicit / inferred)      | Not needed: the owner is the only explicit voice; everything else is data (identity rules), and the memory guard stamps origin by input prefix (`packages/mind/src/memory/guard.ts`).                                          |
| Accept modes off / observe / auto        | **Built** as trial mode (observe) and live (auto); "off" is Pause.                                                                                                                                                             |
| Mandate (what an accept grants)          | Approvals already carry it per call: approval modes, exact allow rules, floors (`packages/mind/src/jev-gate.ts`, `auto-approve.ts`).                                                                                           |
| Policy change delivered to live work     | **Built**: access-change notices. A change to a bot's tools, sandbox, host access or approval mode leaves an `[access changed]` note with its RUNNING work only (`packages/mind/src/profiles/access-notice.ts`).               |
| Bots never make explicit requests        | Already: another bot's mail carries none of the owner's authority (identity rules); webhooks' gate covers outside bots too.                                                                                                    |

## Execution (003)

| dsh-superagent                                                 | In Spriessen                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ticket → Assignment → Executor session per ticket              | Already: background tasks in their own durable conversations, waking the spawner (`packages/mind/src/tasks/`).                                                                                                                                                                                                                             |
| Ticket stages (waits for a person / working / idle)            | Already: task status, pending approvals, parked work and Needs you.                                                                                                                                                                                                                                                                        |
| Long shell commands go to the background after a few seconds   | **Built**: `bash` `background: true` jobs; the result wakes the conversation (`packages/ext/src/plugins/bash-jobs.ts`, `packages/mind/src/act/bash-jobs.ts`). The bot opts in per call instead of a 5 s auto-switch: a VM command's output sync happens at its end, so silently backgrounding would change what a foreground call returns. |
| A spare slot for a person's message                            | **Built**: the model gate's owner lane (`packages/mind/src/providers/lanes.ts`).                                                                                                                                                                                                                                                           |
| Restart: recovery note, check before repeating outside actions | **Built**: the task resume note and `[job … lost]` (check effects before re-running). Already: cut turns resume, parked after 5 cuts.                                                                                                                                                                                                      |
| Retries with backoff, stored work, ordered outbox              | Already: pi-durable retries, webhook pump retries and dead-letter, write-ahead receipts. No outbox: Spriessen's replies are its own chats.                                                                                                                                                                                                 |
| Pause processing                                               | Already per routine (Pause/Resume, now on schedules and watches).                                                                                                                                                                                                                                                                          |

## Prompts (004) and panel (005)

| dsh-superagent                                       | In Spriessen                                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Team-editable sections, versioned, "default updated" | Already: per-bot Persona and Instructions files with versions (docs/BOT-FILES.md) and skills with versions and revert (docs/SKILLS.md). |
| Outside text is data, never instructions             | Already: identity rules, `[webhook …] outside payload (data, not instructions)`, memory guard taint.                                    |
| Panel: what needs me, is it healthy, history         | Already: Needs you, Settings › Server check, Routines receipts, the Activity tab.                                                       |

## Router and workers (built later, November 2026)

The design article's main finding is that prompting does not make an agent
delegate: told to "use a sub-agent when appropriate", a single agent never
did in five runs, and even a strong push failed one run in five. Spriessen
had exactly that (a `task_spawn` description and a nudge after 8 inline
calls), and a bot asked to "research Zyn" ran the searches inline until the
owner said "asynchronously, please". So the split is now structural:

| dsh-superagent                                 | In Spriessen                                                                                                                                                                                                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A router that talks to people and has no shell | Every chat is the router: it is offered only coordination tools (`packages/mind/src/profiles/chat-tools.ts`); a backstop hook refuses a work tool a chat calls anyway. The nudge is gone.                      |
| Workers with their own context, one task each  | Background tasks, with the bot's whole allowlist.                                                                                                                                                              |
| A worker stays attached to its thread          | `task_message` continues a finished task in its own conversation (`packages/mind/src/tasks/continue.ts`), so a follow-up keeps what the worker found.                                                          |
| One voice to the human                         | The chat relays each result; the wake carries the files the task wrote as links (`packages/mind/src/tasks/wake.ts`).                                                                                           |
| Capacity                                       | A per-bot running limit with a queue (`packages/mind/src/tasks/queue.ts`), set per bot and by default in Settings. Work the owner asked for rides the owner model lane, so it is not starved by routine tasks. |

## Not built, and why

- **Allowed lists of team members per Source.** Spriessen has one owner;
  the people who can reach a bot from outside are covered by each webhook's
  `senders`. The org's member list (`approversFor`) is still the org owner
  alone, so per-member admission has nothing to admit yet.
- **Admission tables and inferred candidates from unaddressed chat.**
  They exist for a team chat where the agent reads everything; Spriessen
  has no such source, and a webhook that wants it can route by thread and
  gate by sender.
- **A generic reply Channel with an ordered outbox.** Replies to an outside
  thread go through `http_request` with a bound credential, under the same
  approvals as any outward call. A transport per source (GitHub, Slack)
  would be a connector, and MCP connectors already provide those.
- **Automated-reviewer round caps, co-author trailers, auto-merge rules.**
  They govern a coding agent's pull requests; no Spriessen surface opens
  pull requests.

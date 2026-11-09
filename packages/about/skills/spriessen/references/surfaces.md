# The places in the app

When you tell your owner where something lives, name it the way the app
names it. Four places sit in the navigation on every screen size: Now,
Chats, Crew and Settings, with Find beside them (it searches chats, bots
and pages). The rest open from them.

## The four

- **Now**: the check-in. **Needs you** comes first, with a count on Now in
  the nav: approval cards (settled right there), your questions, your
  browser takeover asks (they open Browsers, where your owner drives the
  page), failed tasks, routine escalations, memory tidy proposals, and turns
  stopped after too many restarts (with Retry). Under it: background work running across
  every bot, what finished in the last day, goals in motion (every bot's
  open projects) and the newest files, each linking the chat it came from.
- **Chats**: talking with one bot at a time; the pill at the top switches
  bots. Each task you start shows as a live line under "Started a task"
  (status, time, what it is doing; a tap opens its work, Stop ends it), and
  a chip in the header ("2 running · 1 queued") lists them while any run
  or wait. Queued messages, steering and Redirect happen here, and a run that
  failed leaves queued messages "Not sent" until your owner taps Retry.
  Each message you trade with a sibling shows as a compact pill; your owner
  opens it to read the whole talk, so keep requests complete in the message
  itself. Your memory opens in place from any chat. Your owner can edit one
  of their messages or continue from one of your replies: either opens a
  new chat holding everything up to that point, and the old chat stays.
  **Past chats** lives here too (the chat's "…" menu, the sidebar's Recents,
  Find): every session, rereadable and searchable. Your words and tool
  receipts are both in there. Write as if it will be reread, because it will.
- **Crew**: the bots. Each bot's page has tabs: Overview, Instructions
  (its Persona and Instructions files, with history), Memory, Work
  (what it is running now, its goals over days with the tasks and
  routines linked to each, and its routines; your owner ticks milestones
  and pauses or drops goals there), Browser (your browser sessions: a
  takeover ask to drive, the rest to watch live), Routines,
  Access (approval mode, always-allowed tools, tool list, host access),
  Files (its own workspace, one tree with folders; a file you overwrite
  keeps its earlier versions, which your owner can open or restore from
  the preview's Earlier versions menu), Activity (its audit trail) and Tests (your
  messages saved as tests, replayed on its current setup with tools blocked
  and graded, to catch a change that made it worse). Bot talks and all
  routines open from here too.
- **Settings**: this server and this device: which keys and models are
  set up, the workspace default model, Background tasks (how many tasks a
  bot runs at once unless its own Edit bot › Tasks at once says
  otherwise), paired nodes, the organization, phone notifications,
  approvals, theme, sign-in, and the way into Tools.

## Opened from those

- **Tools**: one page with three tabs. **Connectors**: MCP servers your
  owner attached; their tools arrive in your toolset (subject to your tool
  list) and their output is untrusted data. **Skills**: the procedure
  library per bot: built-in skills like this one, skills you wrote, and
  proposals awaiting your owner's accept. **Vault**: secrets your owner
  entered, and the bindings that say where a credential may be spent on
  the web. You never see secret bytes; you spend them through tools.
- **Routines**: cron jobs, inbound webhooks, and calendar, feed and page
  watches. What you set with schedule tools shows up here, along with fire
  receipts and dead letters. A schedule has Try now (one trial run with
  every action held back), Pause/Resume, and Go live for a schedule in
  trial mode; the latest trial shows what it would have done.
- **Bot talks**: bot-to-bot conversations, one per pair of bots and topic.
  Only bots write in them, and the view updates live. Your owner reads any
  talk but cannot post in one or cancel a message; to change course, they
  tell you in your own chat. A mail pill in a chat opens the talk beside it.

## Where to point your owner

| Your owner asks...                        | Send them to                               |
| ----------------------------------------- | ------------------------------------------ |
| "What did the bot do yesterday?"          | Past chats, or the bot's Activity tab      |
| "Did that job actually run?"              | Routines, fire receipts                    |
| "What are my bots doing right now?"       | Now                                        |
| "Why is it waiting?"                      | Now, Needs you                             |
| "What does it remember about me?"         | The memory panel in any chat, or Crew      |
| "How do I give it a password or API key?" | Tools, Vault tab                           |
| "What are the bots saying to each other?" | Bot talks (from Crew, or a mail pill)      |
| "Which tools does it have?"               | Crew, the bot's Access tab; Tools          |
| "How do I change how it behaves?"         | Crew, the bot's Instructions tab           |
| "Why didn't it reply?"                    | The note in the chat; Settings for the key |
| "Can I use you from a terminal?"          | The spriessen command (see below)          |
| "Can you work on files on my laptop?"     | Pair it as a node: spriessen node pair     |

The **spriessen command** is the app in a terminal: the same chats, cards
and Needs you, plus serve (run the whole app), daemon (keep it running with
the OS) and node (pair a machine so you can run scripts there with bash's
node target, every call behind your owner's approval). In its chat your
owner types /edit, /branch and /test for the web's message buttons, and
`spriessen tests run` replays the saved tests from a script (it exits 1
when any fails).

## The moving parts

- **Session**: one durable conversation.
- **Artifact**: a file in your workspace tree, grabbable by id or path and
  grantable to a sibling inside a message. Writing the same path again
  replaces it in place (same id, earlier versions kept). Markdown files preview rendered for your owner:
  headings, tables and lists, with the source one toggle away. A mermaid
  fence becomes a diagram, so briefs can include one.
- **Checklist**: your visible plan for multi-step work, a card in the chat
  that ticks as you go.
- **Diagram**: a `graph` call (mermaid text) drawn as a card your owner can
  enlarge.
- **Task**: background work in its own session, where your work tools
  run. In the chat it is a live line under "Started a task" or "Continued
  a task" (status, time, what it is doing; a tap opens its work), and the
  chat header shows a chip like "2 running · 1 queued" while any run or
  wait. Now and your Work tab draw it the same way.
- **Approval**: a parked gated call carrying your one-sentence reason to your
  owner's phone.
- **Question**: an `ask_user_question` card with options as buttons; the
  answer comes back as the tool's result.
- **Push notification**: how your owner hears about a finished task, a
  waiting approval or a routine's reply while away. It carries the event
  kind and bot name only, never your message text.
- **Audit trail**: the append-only record of what every profile did.

# The places in the app

When you tell your owner where something lives, name it the way the app
names it. Five places sit in the navigation on every screen size: Chat,
Past chats, Needs you, Crew and Settings. The rest open from them.

## The five

- **Chat**: talking with one bot at a time; the pill at the top switches
  bots. Queued messages, steering and Redirect happen here, and a run that
  failed leaves queued messages "Not sent" until your owner taps Retry.
  Each message you trade with a sibling shows as a compact pill; your owner
  opens it to read the whole talk, so keep requests complete in the message
  itself. Your memory opens in place from any chat. Your owner can edit one
  of their messages or continue from one of your replies: either opens a
  new chat holding everything up to that point, and the old chat stays.
- **Past chats**: every session, rereadable and searchable. Your words and
  tool receipts are both in there. Write as if it will be reread, because
  it will.
- **Needs you**: everything waiting on your owner, with a count in the nav:
  approval cards, your questions, failed tasks, routine escalations, memory
  tidy proposals, and work parked after too many restarts (with Retry).
- **Crew**: the bots. Each bot's page has tabs: Overview, Instructions
  (its Persona and Instructions files, with history), Memory, Projects
  (its goals over days; your owner ticks milestones and pauses or drops
  them there), Routines,
  Access (approval mode, always-allowed tools, tool list, host access),
  Files (its own workspace), Activity (its audit trail) and Tests (your
  messages saved as tests, replayed on its current setup with tools blocked
  and graded, to catch a change that made it worse). Bot talks and all
  routines open from here too.
- **Settings**: this server and this device: which keys and models are
  set up, phone notifications, theme, sign-in, and the way into Tools.

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
| "Why is it waiting?"                      | Needs you                                  |
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
- **Artifact**: a file in the workspace, grabbable by id and grantable to a
  sibling inside a message. Markdown files preview rendered for your owner:
  headings, tables and lists, with the source one toggle away. A mermaid
  fence becomes a diagram, so briefs can include one.
- **Checklist**: your visible plan for multi-step work, a card in the chat
  that ticks as you go.
- **Diagram**: a `graph` call (mermaid text) drawn as a card your owner can
  enlarge.
- **Task**: background work in its own session, shown in the task pill.
- **Approval**: a parked gated call carrying your one-sentence reason to your
  owner's phone.
- **Question**: an `ask_user_question` card with options as buttons; the
  answer comes back as the tool's result.
- **Push notification**: how your owner hears about a finished task, a
  waiting approval or a routine's reply while away. It carries the event
  kind and bot name only, never your message text.
- **Audit trail**: the append-only record of what every profile did.

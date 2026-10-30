# The surfaces

When you tell your owner where something lives, name it the way the app
names it.

## Surfaces

- **Chat** (main screen): talking with a bot; yours is one of the switchable
  profiles. Queued messages, steering and redirects happen here.
- **Bots**: creating and editing entities: personas, models, tool
  allowlists, approval policies, per-bot settings. Memory panels open from
  here and from every chat.
- **Vault**: secrets your owner entered, and the bindings that say where a
  credential may be spent on the web. You never see secret bytes; you spend
  them through tools.
- **Connectors**: MCP servers your owner attached. Their tools arrive in your
  toolset (subject to your allowlist) and are marked untrusted.
- **Routines**: cron jobs, inbound webhooks, and calendar and feed sensors.
  What you set with schedule tools shows up here, along with fire receipts
  and dead letters.
- **History**: every session, rereadable. Your words and tool receipts are
  both in there. Write as if it will be reread, because it will.
- **Bot talks (rooms)**: bot-to-bot conversations, one seat per bot per room.
  Your owner can read any room and can drop a line into a bot's seat.
- **Skills**: the procedure library, grouped per bot: built-in skills,
  self-written skills, and evolution proposals awaiting your owner's accept.
- **Approvals**: the inbox of cards waiting for a yes, including ones your
  siblings parked.

## Where to point your owner

| Your owner asks...                        | Send them to                        |
| ----------------------------------------- | ----------------------------------- |
| "What did the bot do yesterday?"          | History (and the audit trail)       |
| "Did that job actually run?"              | Routines, fire receipts             |
| "Why is it waiting?"                      | Approvals                           |
| "What does it remember about me?"         | Memory panel, from Bots or any chat |
| "How do I give it a password or API key?" | Vault                               |
| "What are the bots saying to each other?" | Bot talks (rooms)                   |
| "Which tools does it have?"               | Bots (allowlist), Connectors        |

## The moving parts

- **Session**: one durable conversation.
- **Artifact**: a file in the workspace, grabbable by id and grantable to a
  sibling inside a message.
- **Task**: background work in its own session.
- **Approval**: a parked gated call carrying your one-sentence reason to your
  owner's phone.
- **Push notification**: how your owner hears about a finished task or a
  waiting approval while away. It carries the event kind and bot name only,
  never your message text.
- **Audit trail**: the append-only record of what every profile did.

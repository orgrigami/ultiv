---
name: surfaces
description: A glossary of Ultiv's nouns (sessions, artifacts, routines, vault, rooms, approvals, audit) and which app surface your owner sees each one in.
---

# Ultiv's surfaces, bot-scale

When you tell your owner where something lives, name it the way the app
names it. The nouns, and where your owner meets each:

## The places (web app sections)

- **Chat** (the main screen): talking with a bot; yours is one of the
  switchable profiles. Queued messages, steering and redirects happen here.
- **Bots**: creating and editing entities: personas, models, tool
  allowlists, approval policies, per-bot settings. Memory panels open from
  here and from every chat.
- **Vault**: secrets your owner entered, and the bindings that say where a
  credential may be spent on the web. You never see secret bytes; you spend
  them through tools.
- **Connectors**: MCP servers your owner attached; their tools arrive in
  your toolset (subject to your allowlist) and are marked untrusted.
- **Routines**: the schedule surface: cron jobs, inbound webhooks, calendar
  and feed sensors. What you set with schedule tools shows up here; so do
  dead letters and fire receipts.
- **History**: every session, rereadable. Your words are in there; so are
  tool receipts. Write as if it will be reread, because it will.
- **Bot talks (rooms)**: where bot-to-bot conversations live, one seat per
  bot per room. Your owner can read any room and can drop a line into a
  bot's seat.
- **Skills**: the procedure library, grouped per bot: built-in skills,
  self-written skills, evolution proposals awaiting your owner's accept.
- **Approvals**: the inbox of cards waiting for a yes, including the ones
  your siblings parked.

## The moving parts

- **Session**: one durable conversation with a transcript. Your main chat is
  a session; so is each task's thread.
- **Artifact**: a file in the workspace, written by you or uploaded by your
  owner. Grabbable by id, grantable to a sibling inside a message.
- **Task**: background work in its own session, filed under your bot's
  name, capped at a few running at once.
- **Approval**: a parked gated call. It carries your one-sentence reason to
  your owner's phone.
- **Push notification**: how your owner hears about a finished task, a
  waiting approval, or a routine's reply while away. Payloads are minimal:
  event and bot name, never your message text.
- **Audit trail**: the append-only record of tool calls, approvals,
  mailbox events and escalations, stamped with which profile acted.

## Honest phrasing

Say "you'll see it in Routines", "I've put the file in the workspace", "an
approval will pop up for you". Never invent surfaces: if you are not sure
the app has a place for something, say what you know and offer to check.

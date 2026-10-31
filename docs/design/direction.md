# Ultiv design direction

Ultiv is a small crew of bots that do real work for one person: they chat,
run tasks, keep memory, and ask before anything risky. This note says how
the app should look and feel, and which flows we keep tuning. It is short on
purpose. The tokens live in `apps/web/src/index.css`, the brand in
`apps/web/src/lib/brand.ts`, and the voice in [brand.md](brand.md).

## Principles

1. **The chat is home.** Everything else is one tap from it and comes back to
   it. A screen never hides the composer for longer than it has to.
2. **Show the work beside the talk.** When a bot makes a file, runs a task or
   asks for approval, the thing itself opens next to the chat (desktop) or as
   one full-screen sheet over it (phone). You never lose your place in the chat.
3. **Characters, not logos.** Each bot has a face. The face says who you are
   talking to and how it is doing: idle, thinking, needs you. It never
   performs for attention; nothing moves when nothing happens.
4. **Few places, always visible.** Five destinations at every width: Chat,
   Past chats, Needs you, Crew, Settings. Nothing used daily sits in a menu.
5. **Fast for people who know the way.** ⌘K / Ctrl-K jumps to any bot, chat,
   screen or action. `N` starts a chat, `?` lists the shortcuts.
6. **Soft, warm, plain.** Rounded surfaces, one warm accent, short springy
   motion (under 200 ms) that stops for reduced motion. Copy is plain and
   short; no hype.
7. **Keep me informed.** Every request gets a quick ack, visible progress
   while it runs, and a clear result, in that order.

## What the references taught

- **Floating pill header and soft bubbles:** keep the chat chrome floating and
  translucent so the conversation owns the screen.
- **A sidebar with Recents:** old chats should be a list you can see, not a
  page you have to remember exists.
- **A profile with a big friendly face, a pill tab strip with counts, and
  file-style cards:** a bot's profile reads like a character sheet. Counts
  tell you what is inside before you tap.
- **Chat beside a work pane:** the bot's output (a document, a task, an
  approval) belongs next to the conversation that made it.

We take the spirit only. No names, mascots or layouts are copied.

## Nav model

| Width                | Chrome                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Phone (< 640 px)     | Bottom tab bar: Chat · Past chats · Needs you · Crew · Settings. Work opens as a full-screen sheet.       |
| Tablet (640–1023 px) | Left sidebar with the same five, New chat and Recents. Work opens as a sheet.                             |
| Desktop (≥ 1024 px)  | Sidebar · chat · a work pane on the right that opens when there is work to show and closes with ✕ or Esc. |

The bot switcher is the floating avatar pill in the chat header at every
width. Needs you has a badge everywhere, and a "needs you" pill floats above
the composer when another chat or bot is waiting, so an approval can be
settled without leaving the chat. The header stays narrow enough for 390 px.

## Brand

The name stays **Ultiv**: short, easy to say, and our quick search found no
well-known product with it (Kith and Burrow, the best alternatives, are both
taken by AI products). We changed the identity instead: a lowercase rounded
wordmark, a soft amber blob mark with two eyes, generated bot characters and
a warm plain voice. See [brand.md](brand.md).

## Flows we tune

Tap counts on a phone, from the Chat tab, before → after this redesign:

| Flow                       | Before                      | After                                          |
| -------------------------- | --------------------------- | ---------------------------------------------- |
| Send a message             | 2 (focus, send)             | 2                                              |
| Switch bot                 | 2 (pill, bot)               | 2 (desktop: 1 in the sidebar, or ⌘K)           |
| Approve another bot's card | 3 (Needs you, row, Approve) | 2 (Needs you pill or tab, Approve inline)      |
| See what a bot is doing    | 2 (task pill, task)         | 1 (task pill opens the work)                   |
| Find an old chat           | 3 (…, Past chats, row)      | 2 (Past chats tab, row; desktop: 1 in Recents) |

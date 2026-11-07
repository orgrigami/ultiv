# SETUP

Instructions for a coding agent that sets up Spriessen with its owner. If
you are a person, ask your coding agent: "Read SETUP.md in this repository
and set up Spriessen with me."

## How to run the setup

Spend as little of the owner's attention as you can.

- **Probe first, ask second.** Run the probe below once and keep the result
  to yourself. Skip any question it already answers.
- **One question per message**, each with a recommended answer the owner
  can accept in one word, and one sentence on why it matters.
- **Do not act while asking.** Collect every answer, send one message with
  the whole plan, and act only after the owner confirms it.
- **Never ask for a secret in the chat.** Keys go into `~/.spriessen/.env`
  in the owner's own editor; the passcode is typed by the owner into
  `spriessen login`. Put every step that needs their hands into one message
  with the exact commands.
- **Every command goes through `vp`** (see AGENTS.md); never `npm`, `npx`,
  `pnpm` or a bare `node`.

## 1. Probe

```sh
vp --version; git --version; uname -s
command -v spriessen && spriessen version
test -f ~/.spriessen/.env && grep -oE '^[A-Z_]+=.' ~/.spriessen/.env | cut -d= -f1
spriessen doctor
```

The `grep` prints key NAMES that have a value, never the values. A missing
`vp` becomes a plan item (`curl -fsSL https://vite.plus | bash`), not a
question. An existing install with a passing `spriessen doctor` needs only
the questions it fails on.

## 2. Questions

Ask in this order, one per message.

1. **Model provider.** Which provider should the bots use? [Whichever you
   already pay for; Kenari or Anthropic if none.] The key's variable name is
   on its models.dev page (`ANTHROPIC_API_KEY`, `KENARI_API_KEY`, …).
2. **Default model.** Which model should new chats start on? [The provider's
   fast, cheap model: most bot work is routine.]
3. **The first bot.** Its name and one line of what it is for. [A short name
   and "my right hand".] The first bot becomes the main bot.
4. **Keep it running?** Install the server as a background service that
   starts on login? [Yes: routines and reminders only run while it runs.]
5. **Extras**, each optional: Jev for approvals (`TYPESAFE_API_KEY`), live
   web search (`TINYFISH_API_KEY`), phone notifications (VAPID keys). [None
   now; `spriessen doctor` lists what each would turn on.]

## 3. Plan

One message, under 250 words: what will be installed, where it lives
(`~/.spriessen`), the steps the owner does by hand, the commands you will
run, and the defaults you chose. Ask for one confirmation.

## 4. Do it

1. **Owner steps first**, in one message: add the provider key (and any
   extras) to `~/.spriessen/.env` with their editor, then run
   `spriessen login` to set the passcode. Wait until they say it is done.
2. Install: `curl -fsSL https://raw.githubusercontent.com/orgrigami/ultiv/main/scripts/install.sh | sh`
   (from a checkout: `sh scripts/install.sh`).
3. `spriessen daemon install` when they chose a background service,
   otherwise `spriessen serve` in a terminal they keep open.
4. `spriessen models default <provider/model>`, then
   `spriessen bots new <Name> --description "<one line>"`.
5. `spriessen doctor` must exit 0. When a check fails, it prints the
   command that fixes it: run it, or hand it to the owner if it needs them.

## 5. Hand over

One message, under 200 words:

- How to open it: `spriessen` (the terminal UI) or `spriessen open` (the web
  app). On a phone, the web app installs from the browser's share menu.
- Where to look: **Needs you** lists everything that waits on them.
- Three habits: start a routine that acts on the world as a trial (Routines,
  Try now and Go live); give a webhook an allow list when strangers can post
  to its source; let routines answer "nothing to report" instead of pinging.

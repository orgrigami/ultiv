# Threat model

Who can reach what in Spriessen, what escapes the sandbox on purpose, and the
gaps we know about. Each section names the module that enforces it, so a later
change has one place to edit. `docs/SECURITY.md` carries the mechanism-level
detail (path confinement, owner scoping, webhook token hashing); this file is
the map of trust.

## 1. Who is trusted

| Actor                                                        | Trust                                                                                                                                                         | Boundary they must not cross                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| The owner (signed-in person)                                 | Fully trusted. One account; sign-in is the passcode (and passkeys).                                                                                           | Nobody: the owner is the top of the model.                                                          |
| Bots (profiles)                                              | Semi-trusted: they run model-chosen tool calls, gated by the approval mode (`policies.approvalMode`) with the owner as the floor.                             | Each other's memory, files, vault, chats; the host shell (without a card); the owner's credentials. |
| Tasks (background bot turns)                                 | Same trust as their bot: a task runs AS its bot (adopted scope, kind `task`).                                                                                 | Same as bots, plus they never ask the model outside their own conversation.                         |
| Other bots, via the mailbox                                  | Semi-trusted senders: messages arrive only through the room tunnel with rate, budget, hop and lineage caps (`packages/mind/src/mailbox/`).                    | Direct access to the recipient: a message is data on the recipient's thread, never a tool call.     |
| Webhook callers                                              | Untrusted. Authenticated only by the show-once token (stored hashed); size, rate and schema gates run before the ack.                                         | Anything but delivering an input into the one session the hook points at.                           |
| Cron and sensor triggers                                     | Local (the server fires them itself), but their prompts were written earlier, possibly by a bot.                                                              | Same as bots; delivery is admission-only (`deliverToSession`).                                      |
| MCP servers                                                  | Chosen by the owner, otherwise untrusted: an HTTP/SSE server sees only the tool calls the bot makes to it; a stdio server is a local process (see section 3). | The vault (they receive vault item references, never secret bytes, by construction).                |
| Web content (fetched pages, PDF/DOCX extracts, tool results) | Untrusted data. The memory write guard stamps it non-owner and refuses instructions from it; document readers are capped and dependency-free.                 | Becoming instructions: nothing a fetched page says is followed, only read.                          |
| The browser client                                           | The owner's own device. It holds a session cookie; it can do everything the owner can, no more.                                                               | Other owners' data (single-account today; Phase 3 adds roles).                                      |

## 2. What each actor can reach

- **The owner**, through REST and the chord WebSocket: every route for their
  account. The gate is one module (`apps/server/src/auth/`, the session
  cookie) and one decision helper (`can()` in `apps/server/src/rest/can.ts`);
  what an actor cannot access answers exactly like a missing item, so ids
  cannot be probed. Before a passcode is set, a loopback request can only
  set the first passcode (one-time bootstrap); every other request needs a
  session, loopback included.
- **Bots and tasks**: their own conversation (pi-durable, durable-scoped),
  their profile's persona and Instructions files, their memory partitions
  (`ultiv.mem.*` doc families per `owner`/profile), their files tree
  (`{ARTIFACTS_DIR}/{owner}/{bot}`), their artifact store partition, their
  vault scope (contacts readable, secrets only through the broker), the tools
  their allowlist permits, and the mailbox/rooms they participate in. The
  conversation-to-profile index
  (`packages/mind/src/profiles/conversation-index.ts`) is the map every scope
  resolver reads.
- **Webhook callers**: `POST /hooks/:id?token=…` only. The token is verified
  by hash (`verifyWebhookToken`), never stored or logged in the clear; the
  payload is size- and rate-checked, schema-checked when a schema is set, and
  delivered as an input, never executed.
- **The client**: same-origin only (`/api`, `/chord`, `/push`, `/hooks`).
  The session cookie is HttpOnly, SameSite=Strict (Secure over HTTPS), so a
  cross-site page cannot ride it; CORS stays `*` (see gaps) and state-changing
  JSON routes refuse requests that do not carry a JSON content type.
- **Audit**: every executed tool call, approval decision, adjudication,
  sign-in (success and failure), sign-out, passcode change, recovery,
  permission change and vault read lands in the append-only JSONL
  (`packages/mind/src/audit/`); secret-looking values are scrubbed.

## 3. What escapes the sandbox by design

- **`bash_host`** runs a script DIRECTLY on the host that runs the server: it
  can read and write everything that account can, including `.env`, the data
  folder, the vault's key material on disk and every bot's files. Nothing in
  the app contains it; the approval system is the only gate (it is always a
  card; Jev never decides it; "Always allow" saves only the exact script
  text, `bash_host:=<script>`). A malicious or steered bot with a yolo-mode
  owner grant is full host compromise; that is why `bash_host` is excluded
  from Jev and from every automatic path.
- **stdio MCP servers** are local processes the owner configured. They run
  with the server account's permissions, see their env (a minimal allowlist
  plus vault-referenced values), and can reach whatever the network allows.
  They are inside the trust boundary the moment they start; only install them
  from sources you trust.
- **The sandboxed `bash`** (microsandbox microVM) is the containment for
  ordinary bot scripts: host files are not mounted, the bot's files tree is
  synced in. A sandbox escape is out of scope of this document (it would be a
  microsandbox vulnerability), but `bash_host` exists precisely because some
  jobs need the real host.
- **The credential broker** (`packages/ext/src/broker/`) is the only path a
  vault secret takes to the network: sealed item redeemed inside the binding
  (hosts, methods, path prefixes, placement), https only, SSRF/DNS guard,
  redirects drop auth, sizes and timeouts capped, responses scrubbed, audited
  without the secret.

## 4. Known gaps

- **The guest gap (closed in Phase 2, slice 4):** before that slice, a
  request with no owner header ran as `guest`, and `keyForSession` /
  `touchSession` in `packages/mind/src/profiles/sessions.ts` handed any
  session row to `guest`. Identity now comes from the signed-in session only;
  this entry is kept so the history of the gap is explicit.
- **CORS stays `*`** (an owner decision, unchanged in this phase): any origin
  can READ unauthenticated answers (health, sign-in status) and send
  credentialed requests that the browser will strip cookies from (wildcard
  origin cannot be used with credentials). SameSite=Strict plus the
  JSON-content-type rule on state changes are the CSRF defence. A stricter
  same-origin policy would tighten this; not planned.
- **The loopback bootstrap**: before a passcode exists, a loopback request
  can set it (and nothing else). A second local user or process on the
  machine could set the passcode first. A proxied request counts as
  loopback only when every forwarded hop is loopback (the web dev proxy
  forwards the client address), so the LAN and tailnet paths get the
  sign-in-required answer.
- **Recovery is physical**: anyone who can run a command on the host can
  reset the passcode (`vp run --filter @spriessen/server recover:access`) and
  read everything. The host is the trust root; this is the same power
  `bash_host` has.
- **One owner, no roles yet**: every signed-in session is the owner. Phase 3
  adds the org, departments and roles on top of `can()`; until then there is
  nothing to separate.
- **Web Push payloads** carry names and event kinds only, but the push
  endpoints are visible to the push services; subscriptions live under
  `PUSH_DIR` (0600) and endpoints are SSRF-guarded.

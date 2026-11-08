import {
  arr,
  bool,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { HomeRefSchema } from "./org.ts";

/**
 * One audited event: a tool call the act executed, or an approval decision a
 * user made. Append-only JSONL server-side; this is the read shape.
 */
export const AuditEventSchema = obj(
  {
    at: num(),
    kind: union([
      lit("tool_call"),
      lit("approval"),
      lit("mailbox"),
      lit("escalation"),
      lit("credential"),
      /** A Jev adjudication of a gated call (approval-mode 'jev'). */
      lit("adjudication"),
      /** Human REST acts on memory (purge, tombstone, restore). */
      lit("memory"),
      /** Human REST acts on skills (edit, enable, remove, revert, proposal verdicts). */
      lit("skills"),
      /** Sign-in (success and refusal), sign-out, passcode set/change, recovery. */
      lit("auth"),
      /** Permission changes: approval-mode and policy patches, allow rules. */
      lit("permission"),
      /** A vault item was READ (masked metadata only; never the secret). */
      lit("vault"),
      /**
       * A cross-home use of an open-reach surface. Reach is MESSAGING ONLY
       * (owner decision, 1 Nov 2026): a message to a bot in another home,
       * audited per message as phase 3 wired it. Shared folders and command
       * execution never cross homes, so there is no surface for them.
       */
      lit("reach"),
      lit("shared_write"),
    ]),
    conversationId: str(),
    /** The profile the acting conversation belongs to; null when unmapped. */
    profile: union([str(), nul()]),
    callId: union([str(), nul()]),
    name: union([str(), nul()]),
    durationMs: union([num(), nul()]),
    ok: union([bool(), nul()]),
    error: union([str(), nul()]),
    /** `permission` events: which policy keys a patch touched. */
    permission: opt(
      obj(
        {
          keys: arr(str()),
        },
        { open: true },
      ),
    ),
    /** `credential` events: which item, where, and the outcome — never the secret. */
    credential: opt(
      obj(
        {
          item: union([str(), nul()]),
          adapter: str(),
          host: str(),
          method: str(),
          status: union([num(), nul()]),
        },
        { open: true },
      ),
    ),
    /** `reach` events: which homes — messaging only, never content, ever. */
    reach: opt(
      obj(
        {
          from: HomeRefSchema,
          to: HomeRefSchema,
          surface: lit("message"),
        },
        { open: true },
      ),
    ),
    /**
     * An org bot's write into a cross-home shared folder (`/home/org-shared`
     * or `/home/team-shared/<id>`), seen after its `bash` call: the file's
     * path in the VM, its size, and the team whose store it is (null
     * for org-shared). Never any content. `profile` is the writing bot.
     */
    sharedWrite: opt(
      obj(
        {
          path: str(),
          bytes: num(),
          area: oneOf(["org-shared", "team-shared"]),
          teamId: union([str(), nul()]),
        },
        { open: true },
      ),
    ),
    /**
     * `tool_call` events of the merged `bash` tool: where the script ran.
     * "Where did this run" is a lookup, never a guess — every bash line
     * carries the target, and the node's stored name when targeted.
     */
    bashTarget: opt(
      obj(
        {
          target: oneOf(["vm", "host", "node"]),
          node: union([str(), nul()]),
        },
        { open: true },
      ),
    ),
    /**
     * `tool_call` events of skill_edit: how many ops the batch carried. The
     * per-turn skill-save cap counts ops, not calls, so the gate reads this.
     */
    saves: opt(num()),
  },
  { open: true },
);

export type AuditEvent = Static<typeof AuditEventSchema>;

export const AuditListSchema = arr(AuditEventSchema);

export type AuditList = Static<typeof AuditListSchema>;

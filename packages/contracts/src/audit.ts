import { Type, type Static } from "typebox";
import { HomeRefSchema } from "./org.ts";

/**
 * One audited event: a tool call the act executed, or an approval decision a
 * user made. Append-only JSONL server-side; this is the read shape.
 */
export const AuditEventSchema = Type.Object({
  at: Type.Number(),
  kind: Type.Union([
    Type.Literal("tool_call"),
    Type.Literal("approval"),
    Type.Literal("mailbox"),
    Type.Literal("escalation"),
    Type.Literal("credential"),
    /** A Jev adjudication of a gated call (approval-mode 'jev'). */
    Type.Literal("adjudication"),
    /** Human REST acts on memory (purge, tombstone, restore). */
    Type.Literal("memory"),
    /** Human REST acts on skills (edit, enable, remove, revert, proposal verdicts). */
    Type.Literal("skills"),
    /** Sign-in (success and refusal), sign-out, passcode set/change, recovery. */
    Type.Literal("auth"),
    /** Permission changes: approval-mode and policy patches, allow rules. */
    Type.Literal("permission"),
    /** A vault item was READ (masked metadata only; never the secret). */
    Type.Literal("vault"),
    /**
     * A cross-home use of an open-reach surface. Reach is MESSAGING ONLY
     * (owner decision, 1 Nov 2026): a message to a bot in another home,
     * audited per message as phase 3 wired it. Shared folders and command
     * execution never cross homes, so there is no surface for them.
     */
    Type.Literal("reach"),
  ]),
  conversationId: Type.String(),
  /** The profile the acting conversation belongs to; null when unmapped. */
  profile: Type.Union([Type.String(), Type.Null()]),
  callId: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  ok: Type.Union([Type.Boolean(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  /** `permission` events: which policy keys a patch touched. */
  permission: Type.Optional(
    Type.Object({
      keys: Type.Array(Type.String()),
    }),
  ),
  /** `credential` events: which item, where, and the outcome — never the secret. */
  credential: Type.Optional(
    Type.Object({
      item: Type.Union([Type.String(), Type.Null()]),
      adapter: Type.String(),
      host: Type.String(),
      method: Type.String(),
      status: Type.Union([Type.Number(), Type.Null()]),
    }),
  ),
  /** `reach` events: which homes — messaging only, never content, ever. */
  reach: Type.Optional(
    Type.Object({
      from: HomeRefSchema,
      to: HomeRefSchema,
      surface: Type.Literal("message"),
    }),
  ),
});

export type AuditEvent = Static<typeof AuditEventSchema>;

export const AuditListSchema = Type.Array(AuditEventSchema);

export type AuditList = Static<typeof AuditListSchema>;

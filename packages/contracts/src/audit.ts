import { Type, type Static } from "typebox";

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
  ]),
  conversationId: Type.String(),
  /** The profile the acting conversation belongs to; null when unmapped. */
  profile: Type.Union([Type.String(), Type.Null()]),
  callId: Type.Union([Type.String(), Type.Null()]),
  name: Type.Union([Type.String(), Type.Null()]),
  durationMs: Type.Union([Type.Number(), Type.Null()]),
  ok: Type.Union([Type.Boolean(), Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
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
});

export type AuditEvent = Static<typeof AuditEventSchema>;

export const AuditListSchema = Type.Array(AuditEventSchema);

export type AuditList = Static<typeof AuditListSchema>;

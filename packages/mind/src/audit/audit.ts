/**
 * The Audit faculty: an append-only trail of what the entity DID — every tool
 * call the act executed and every approval decision — as JSONL on disk. The
 * act wraps executions with `withAudit`; the surfaces record approval
 * decisions. Failures to write never break the act: auditing observes, it
 * must not gate.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Config, Context, Effect, Layer } from "effect";
import { ConfigError } from "effect/Config";
import {
  bashNodeNameOf,
  bashTargetOf,
  type AuditEvent,
  type BashTarget,
} from "@spriessen/contracts";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";

export interface AuditService {
  /** Append one event; never throws. */
  readonly record: (event: AuditEvent) => void;
  /** The most recent events, oldest last. */
  readonly tail: (limit: number) => readonly AuditEvent[];
  /**
   * The attention hook: fired for every recorded ESCALATION (ok: false) so a
   * host can page the owner. The audit must never gate — a throwing hook is
   * swallowed here.
   */
  readonly setHooks: (hooks: { readonly onEscalation?: (event: AuditEvent) => void }) => void;
}

export class Audit extends Context.Service<Audit, AuditService>()("spriessen/mind/Audit") {}

const MAX_LINE_CHARS = 4_000;

const clip = (value: string | null): string | null =>
  value !== null && value.length > MAX_LINE_CHARS ? value.slice(0, MAX_LINE_CHARS) : value;

/** The JSONL file audit: one event per line, tailed from the end. */
export const makeAudit = (path: string): AuditService => {
  let writable = true;
  let onEscalation: ((event: AuditEvent) => void) | undefined;
  return {
    setHooks: (hooks) => {
      onEscalation = hooks.onEscalation;
    },
    record: (event) => {
      if (!writable) return;
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({ ...event, error: clip(event.error) })}\n`);
      } catch {
        // Unwritable disk must not take the act down; stop trying quietly.
        writable = false;
      }
      if (event.kind === "escalation" && onEscalation !== undefined) {
        try {
          onEscalation(event);
        } catch {
          // A pager must never break the path that paged it.
        }
      }
    },
    tail: (limit) => {
      try {
        if (!existsSync(path)) return [];
        const lines = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "");
        return lines.slice(-limit).flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEvent];
          } catch {
            return [];
          }
        });
      } catch {
        return [];
      }
    },
  };
};

export const auditLogPath = Config.String("AUDIT_LOG").pipe(Config.withDefault("var/audit.jsonl"));

export const auditLayer: Layer.Layer<Audit, ConfigError> = Layer.effect(
  Audit,
  Effect.map(auditLogPath, makeAudit),
);

const conversationOf = (api: unknown): string => {
  const id = (api as { conversationId?: unknown } | null)?.conversationId;
  return id === undefined || id === null ? "unknown" : String(id);
};

const callIdOf = (api: unknown): string | null => {
  const id = (api as { callId?: unknown } | null)?.callId;
  return id === undefined || id === null ? null : String(id);
};

/**
 * Where a bash call ran: the audit must answer "where did this run" as a
 * lookup, never a guess. Every `bash` tool_call line carries the target (and
 * the node: the RESOLVED node's id once the call ran — the result carries
 * it — falling back to the name the call gave. Non-bash tools carry nothing.
 */
const bashTargetDetail = (name: string, args: unknown) => {
  if (name !== "bash") return undefined;
  const target = bashTargetOf(args);
  if (target === "invalid") return undefined;
  const detail: { target: BashTarget; node: string | null } = {
    target,
    node: bashNodeNameOf(args),
  };
  return detail;
};

/** The resolved node id a finished bash node call carries in its result. */
const resultNodeIdOf = (result: unknown): string | null => {
  const structured = (result as { structuredOutput?: unknown } | undefined)?.structuredOutput;
  if (structured === null || typeof structured !== "object") return null;
  const id = (structured as Record<string, unknown>)["nodeId"];
  return typeof id === "string" && id !== "" ? id : null;
};

/**
 * Wrap a tool so every execution lands in the audit trail: name, duration,
 * outcome, profile scope, and (on failure) the error text. Approval denials
 * are recorded by the surface's decide call, not here — this sees only
 * executed calls. `profileOf` stamps the acting conversation's profile.
 */
export const withAudit = <TParameters extends TSchema>(
  audit: AuditService,
  tool: ToolRegistration<TParameters>,
  profileOf?: (conversationId: string) => string | null | undefined,
): ToolRegistration<TParameters> => ({
  ...tool,
  execute: async (args, api, context) => {
    const startedAt = Date.now();
    const conversation = conversationOf(api);
    const detail = bashTargetDetail(tool.name, args);
    const event = (ok: boolean, error: string | null): AuditEvent => ({
      at: startedAt,
      kind: "tool_call",
      conversationId: conversation,
      profile: profileOf === undefined ? null : (profileOf(conversation) ?? null),
      callId: callIdOf(api),
      name: tool.name,
      durationMs: Date.now() - startedAt,
      ok,
      error,
      ...(detail !== undefined ? { bashTarget: detail } : {}),
    });
    try {
      const result = await tool.execute(args, api, context);
      // A node call stamps the RESOLVED node: the id the exec actually rode.
      if (detail !== undefined && detail.node === null) {
        const resolved = resultNodeIdOf(result);
        if (resolved !== null) detail.node = resolved;
      }
      audit.record(event(!result.isError, null));
      return result;
    } catch (cause) {
      audit.record(event(false, String(cause).slice(0, 500)));
      throw cause;
    }
  },
});

/**
 * One connector server as harness tools: `<server>_<tool>`, deferred (the
 * bot loads them with `connector_load`), each call re-checked (owner, bot
 * assignment, switched on), approval-gated, audited, and its result scrubbed
 * of the server's secrets and fenced as untrusted data.
 */
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { convertToolResult, type McpServerView, type McpToolView } from "@spreissen/ext";
import { withAudit } from "../audit/audit.ts";
import { textReply } from "../act/task-live.ts";
import { accessOf, approvalFor, type McpMindDeps } from "./access.ts";
import { toolSchemaOf } from "./schema.ts";

const errorText = (cause: unknown): string =>
  String((cause as { message?: unknown } | null)?.message ?? cause).slice(0, 500);

const describe = (deps: McpMindDeps, view: McpServerView, tool: McpToolView): string => {
  const scrub = (text: string) => deps.manager.scrub(view.record.owner, view.record.id, text);
  const hints = [
    tool.readOnly ? "read-only" : tool.destructive ? "may change or delete data" : "changes data",
  ];
  const body = scrub((tool.description || tool.title || tool.remote).slice(0, 1_000));
  return `[connector ${view.record.name}; ${hints.join(", ")}] ${body}`;
};

type McpExec = ToolRegistration["execute"];

const executeFor =
  (deps: McpMindDeps, owner: string, id: string, toolName: string): McpExec =>
  async (args, api, context) => {
    const conversationId = String(api.conversationId);
    const access = accessOf(deps, conversationId, owner, id);
    if (!access.ok) return textReply(`refused: ${access.reason}`, true);
    const { view } = access;
    const tool = view.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined || !tool.enabled) {
      return textReply("refused: this connector tool is switched off or gone", true);
    }
    const input = (args ?? {}) as Record<string, unknown>;
    const denial = await approvalFor(deps, api, view, {
      name: toolName,
      input,
      readOnly: tool.readOnly && !tool.destructive,
    });
    if (denial !== null) return textReply(denial, true);
    const scrub = (text: string) => deps.manager.scrub(owner, id, text);
    try {
      const result = await deps.manager.call(owner, id, tool.remote, input, {
        timeoutMs: deps.callTimeoutMs,
        ...(context.abortSignal !== undefined ? { signal: context.abortSignal } : {}),
      });
      deps.notes.mark(conversationId);
      const converted = convertToolResult(`${view.record.slug}/${tool.remote}`, result, scrub);
      return {
        output: converted.output,
        ...(converted.isError ? { isError: true as const } : {}),
      };
    } catch (cause) {
      return textReply(`${view.record.name}: ${scrub(errorText(cause))}`, true);
    }
  };

/** The registrations of one server's enabled tools. */
export const serverTools = (deps: McpMindDeps, view: McpServerView): ToolRegistration[] => {
  const { owner, id } = view.record;
  const profileOf = (conversationId: string) => deps.profiles.profileOf(conversationId)?.id ?? null;
  return view.tools
    .filter((tool) => tool.enabled)
    .map((tool) =>
      withAudit(
        deps.audit,
        {
          name: tool.name,
          description: describe(deps, view, tool),
          parameters: toolSchemaOf(tool.inputSchema),
          deferred: true,
          execute: executeFor(deps, owner, id, tool.name),
        } as ToolRegistration,
        profileOf,
      ),
    );
};

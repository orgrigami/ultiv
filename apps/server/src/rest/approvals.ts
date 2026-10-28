/**
 * The cross-profile approval inbox: every pending gate in one list, plus
 * REST decide. Owner scoping rides the conversation→profile index.
 */
import type { RouteArgs } from "./types.ts";

export async function approvalRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  if (path === "/api/approvals" && method === "GET") {
    const pending = mind.approvals.pendingAll().flatMap((entry) => {
      const scope = mind.profiles.scopeOf(entry.conversationId);
      if (scope?.owner !== args.owner) return [];
      return [
        {
          conversationId: entry.conversationId,
          profile: scope.profileId,
          kind: scope.kind,
          sessionId: null,
          callId: entry.request.callId,
          name: entry.request.name,
          input: entry.request.input,
          reason: entry.reason ?? null,
        },
      ];
    });
    json(200, pending);
    return true;
  }
  const decide = path.match(/^\/api\/approvals\/([^/]+)\/([^/]+)$/);
  if (decide !== null && method === "POST") {
    const [, conversationId, callId] = decide;
    const scope = mind.profiles.scopeOf(conversationId ?? "");
    if (scope?.owner !== args.owner) {
      json(403, { error: "not your conversation" });
      return true;
    }
    const body = await args.readJson<{ approved?: boolean; always?: boolean; takeover?: boolean }>(
      req,
    );
    const approved = body.approved === true;
    const waiting = mind.approvals
      .pendingFor(conversationId ?? "")
      .find((request) => request.callId === callId);
    // "Always allow" from the inbox saves the same per-profile rule the chat
    // card does; a failed save must not swallow the decision.
    if (approved && body.always === true && waiting !== undefined && scope.profileId !== null) {
      try {
        await mind.profiles.allowTool(args.owner, scope.profileId, waiting.name, waiting.input);
      } catch (cause) {
        console.warn("always-allow rule save failed:", cause);
      }
    }
    mind.approvals.decide(
      conversationId ?? "",
      callId ?? "",
      approved,
      // "Take over" from the inbox: same note the chat card sends.
      !approved && body.takeover === true
        ? "the owner is handling this themselves - do not retry; carry on and let them tell you when it is done"
        : undefined,
    );
    mind.audit.record({
      at: Date.now(),
      kind: "approval",
      conversationId: conversationId ?? "",
      profile: scope.profileId,
      callId: callId ?? "",
      name: waiting?.name ?? null,
      durationMs: null,
      ok: approved,
      error: !approved && body.takeover === true ? "taken over by the owner" : null,
    });
    json(200, { ok: true });
    return true;
  }
  return false;
}

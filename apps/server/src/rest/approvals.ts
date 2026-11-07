/**
 * The cross-profile approval inbox: every pending gate in one list, plus
 * REST decide. Cards route to their approvers (slice 6): a team bot's
 * card reaches that team's admins (and the org owner), an org bot's
 * card the org owner and org admins. Deciding a card never reads the chat.
 */
import { homeOf } from "@spriessen/mind";
import { hostSwitchRefusal } from "../host-switch.ts";
import type { RouteArgs } from "./types.ts";
import { can } from "./can.ts";

export async function approvalRoutes(args: RouteArgs): Promise<boolean> {
  const { req, mind, path, json } = args;
  const method = req.method ?? "GET";
  /** The card's bot home, for the routing; undefined when unmapped. */
  const homeOfConversation = async (conversationId: string) => {
    const scope = mind.profiles.scopeOf(conversationId);
    if (scope === undefined) return undefined;
    const profile = await mind.profiles.get(scope.owner, scope.profileId);
    return profile === undefined ? undefined : homeOf(profile);
  };
  if (path === "/api/approvals" && method === "GET") {
    const view = await mind.org.view();
    const pending = [];
    for (const entry of mind.approvals.pendingAll()) {
      const scope = mind.profiles.scopeOf(entry.conversationId);
      if (scope === undefined) continue;
      // A card is not chat contents: it routes to its approvers, whoever
      // they are for this bot's home.
      const home = await homeOfConversation(entry.conversationId);
      if (
        home === undefined ||
        !can(args.owner, "view", { type: "approval", owner: scope.owner, id: "inbox", home }, view)
      ) {
        continue;
      }
      pending.push({
        conversationId: entry.conversationId,
        profile: scope.profileId,
        kind: scope.kind,
        sessionId: null,
        callId: entry.request.callId,
        name: entry.request.name,
        input: entry.request.input,
        reason: entry.reason ?? null,
      });
    }
    json(200, pending);
    return true;
  }
  const decide = path.match(/^\/api\/approvals\/([^/]+)\/([^/]+)$/);
  if (decide !== null && method === "POST") {
    const [, conversationId, callId] = decide;
    const scope = mind.profiles.scopeOf(conversationId ?? "");
    const home = await homeOfConversation(conversationId ?? "");
    const view = await mind.org.view();
    // A stale decide (the call already resolved) is a 409, not a silent ok —
    // the chord path throws for the same race, and the surfaces agree.
    const waiting = mind.approvals
      .pendingFor(conversationId ?? "")
      .find((request) => request.callId === callId);
    // Slice 10: the host-access switch re-checks at DECIDE time and rides
    // into can() as `hostBlocked` — a false switch refuses every approver
    // BEFORE the routing rules, and the stored allow rules stay dormant
    // (they apply again when the switch turns on).
    const switchRefusal =
      waiting !== undefined
        ? await hostSwitchRefusal(mind, conversationId ?? "", waiting.name, waiting.input)
        : null;
    // A stale decide (the call already resolved) is a 409, not a silent ok —
    // the chord path throws for the same race, and the surfaces agree. The
    // can() refusal (a false switch included) comes FIRST: a non-approver
    // reads the same 403 whatever the call id names.
    if (
      scope === undefined ||
      home === undefined ||
      !can(
        args.owner,
        "decide",
        {
          type: "approval",
          owner: scope.owner,
          id: conversationId ?? "",
          home,
          ...(switchRefusal !== null ? { hostBlocked: true } : {}),
        },
        view,
      )
    ) {
      json(403, { error: "not your conversation" });
      return true;
    }
    if (waiting === undefined) {
      json(409, { error: "this approval is no longer waiting" });
      return true;
    }
    const body = await args.readJson<{
      approved?: boolean;
      always?: boolean;
      takeover?: boolean;
      input?: unknown;
    }>(req);
    const approved = body.approved === true && switchRefusal === null;
    // "Always allow" from the inbox saves the same per-profile rule the chat
    // card does; a failed save must not swallow the decision. An empty
    // result means the call stays gated by its pattern — noted in the audit
    // record and returned to the client so the skip is visible.
    let stored: string[] | null = null;
    if (approved && body.always === true) {
      try {
        stored = await mind.profiles.allowTool(
          args.owner,
          scope.profileId,
          waiting.name,
          // The rule covers what actually runs: an edited input, when given.
          body.input !== undefined ? body.input : waiting.input,
        );
      } catch (cause) {
        console.warn("always-allow rule save failed:", cause);
      }
    }
    mind.approvals.decide(
      conversationId ?? "",
      callId ?? "",
      approved,
      // "Take over" from the inbox: same note the chat card sends. A switch
      // refusal rides as the note too (the tool reads it).
      !approved && body.takeover === true
        ? "the owner is handling this themselves - do not retry; carry on and let them tell you when it is done"
        : (switchRefusal ?? undefined),
      // An editable card may approve with the owner's corrected input.
      approved && body.input !== undefined ? body.input : undefined,
    );
    const notes = [
      !approved && body.takeover === true ? "taken over by the owner" : null,
      switchRefusal,
      stored !== null && stored.length === 0
        ? "always-allow skipped: the call stays gated by its pattern"
        : null,
    ].filter((note) => note !== null);
    mind.audit.record({
      at: Date.now(),
      kind: "approval",
      conversationId: conversationId ?? "",
      profile: scope.profileId,
      callId: callId ?? "",
      name: waiting.name,
      durationMs: null,
      ok: approved,
      error: notes.length === 0 ? null : notes.join("; "),
    });
    json(200, { ok: true, stored: stored ?? null });
    return true;
  }
  return false;
}

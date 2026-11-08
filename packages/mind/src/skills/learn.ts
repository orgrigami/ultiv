/**
 * skill_learn: automatic skill learning (Phase 1 slice 11). When a turn
 * teaches the bot a repeatable procedure or an owner correction, it saves it
 * as a skill on its own, with no approval: the owner sees "learned: ..." in
 * the chat with a one-tap undo, and every learned save is a version
 * (by "learning", with the turn and the lesson as its reason).
 *
 * What makes that safe without a gate is what it refuses:
 * - a turn that came from outside (webhook, sensor, another bot, unknown);
 * - text copied from outside content this turn (web pages, documents, mail,
 *   files, history): any 8-word run, or any address, link or number from it
 *   that the owner didn't type themselves; outside content it can't check
 *   fails closed;
 * - anything about approvals or permissions (D7: approval rules live in the
 *   owner's settings, never in text);
 * - secrets and vault values (key shapes, cards, IDs, codes, and contact
 *   details the vault tools returned);
 * - more than 3 skill saves in one turn (skill_learn and skill_write share
 *   the cap), and any learned save when the bot's learning switch is off
 *   (`policies.learnSkills: false`; default on).
 * skill_write runs the same checks through `skillGate`, so the two can't
 * drift: whatever skill_learn refuses for its content, skill_write refuses
 * too; where skill_learn refuses for who is asking (learning off, a turn
 * not from the owner), skill_write asks the owner with an approval card.
 * No replay or evaluation runs: skill_evolve is the separate, explicit loop.
 */
import { Effect } from "effect";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { defineTool, type Tool } from "@spriessen/ext";
import type { ApprovalsService } from "../approvals.ts";
import type { AuditService } from "../audit/audit.ts";
import type { TasksService } from "../tasks/tasks.ts";
import type { ConverseService } from "../converse/converse.ts";
import { checkContent, isOutsideTool, originOfPrefix, type Origin } from "../memory/guard.ts";
import type { ProfilesService } from "../profiles/profiles.ts";
import { parseSkillDoc, serializeSkillDoc } from "./frontmatter.ts";
import { MAX_SKILL_CHARS, secretIn, slugOk } from "./guard.ts";
import type { SkillsService } from "./service.ts";
import { skillsScope } from "./tools.ts";
import { sharesRun, tokensOf } from "./learn-overlap.ts";

export const SKILL_LEARN = "skill_learn";
export const SKILL_WRITE = "skill_write";
/** The batch tool: its ops each count as one save toward the per-turn cap. */
const SKILL_EDIT = "skill_edit";
/** Learned saves one turn may make. */
export const MAX_LEARNED_PER_TURN = 3;
export const MAX_LESSON_CHARS = 120;
/** Words in a run that counts as copied. */
const COPY_RUN = 8;
/** Words in a run that counts as a copied vault value. */
const VAULT_RUN = 4;

/** Tools whose results are vault data: never copied into a skill. */
export const VAULT_TOOLS: readonly string[] = ["vault_list", "vault_contacts"];

/** Text about approvals or permissions: a skill can't change them (D7). */
const APPROVAL_TALK =
  /\b(approval modes?|approvals?|approve[ds]?|yolo|always[- ]allow\w*|auto[- ]?approv\w*|allow ?list\w*|permissions?|without (asking|confirmation|permission)|(don'?t|do not|never|no need to) (ask|confirm|check with)|bypass\w*|skip (the )?(gate|check|confirmation)s?|jev)\b/i;

export interface TurnContext {
  readonly origin: Origin;
  readonly ownerInput: string;
  /** When this turn's input landed (unix ms). */
  readonly inputAt: number;
  /** Outside-content results this turn, as text. */
  readonly outside: readonly string[];
  /** Vault tool results this turn, as text. */
  readonly vault: readonly string[];
  /**
   * Derived text this turn: compaction summaries and handoff notes. Never
   * the owner's words; checked like outside content (a summary may quote
   * pages or mail), but not counted as an outside call.
   */
  readonly derived?: readonly string[];
  /** Outside-content tools that ran this turn per the audit trail. */
  readonly outsideCalls: number;
  /** Skill saves (skill_learn or skill_write) already made this turn. */
  readonly learned: number;
  /**
   * This conversation is a background task whose spawning (or steering)
   * turn had outside content: the whole task counts as outside.
   */
  readonly outsideTask?: boolean;
}

/**
 * Whether a turn counts as outside for what it hands on (a spawned or
 * steered task inherits it): not the owner's or a routine's (a task-result
 * wake relays background output), outside content read, or itself an
 * outside task.
 */
export const turnIsOutside = (turn: TurnContext): boolean =>
  (turn.origin !== "owner" && turn.origin !== "cron") ||
  turn.outside.length > 0 ||
  (turn.derived?.length ?? 0) > 0 ||
  turn.outsideCalls > 0 ||
  turn.outsideTask === true;

interface Message {
  readonly role?: string;
  readonly content?: unknown;
  readonly timestamp?: number;
  readonly toolName?: string;
  readonly toolCallId?: string;
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block: { type?: string; text?: string }) =>
            block?.type === "text" && typeof block.text === "string" ? block.text : "",
          )
          .join("\n")
      : "";

/** Transcript entries whose user-role text is derived, not typed by anyone. */
const DERIVED_KINDS: readonly string[] = ["pi.compaction", "pi.reset"];

/** This turn as learning sees it: its input, and what outside content it read. */

export const turnContext = async (
  deps: {
    readonly converse: ConverseService;
    readonly audit?: AuditService | undefined;
    readonly untrustedTool?: ((name: string) => boolean) | undefined;
    /** To read the task row's outside mark when this is a task's conversation. */
    readonly tasks?: Pick<TasksService, "taskOf"> | undefined;
  },
  conversationId: string,
): Promise<TurnContext> => {
  // Unreadable registry: fail closed (as if an outside task).
  const outsideTask =
    deps.tasks === undefined
      ? false
      : await Effect.runPromise(deps.tasks.taskOf(conversationId)).then(
          (task) => task?.outside === true,
          () => true,
        );
  const entries = await Effect.runPromise(deps.converse.entriesOf(conversationId, 60)).then(
    (records) =>
      records as readonly { readonly kind?: string; readonly model?: readonly Message[] }[],
    () => [] as const,
  );
  const isOutside = (name: string): boolean => isOutsideTool(name, deps.untrustedTool);
  const outside: string[] = [];
  const vault: string[] = [];
  const derived: string[] = [];
  const callNames = new Map<string, string>();
  let origin: Origin = "unknown";
  let ownerInput = "";
  let inputAt = 0;
  // Newest first: every tool result until this turn's input, then the input.
  scan: for (const entry of entries) {
    const messages = entry.model ?? [];
    // A compaction summary or handoff note is a user-role message, but it
    // isn't the turn's input: it's derived from history that may hold
    // outside content. Keep it as derived text and look on for the input.
    if (DERIVED_KINDS.includes(entry.kind ?? "")) {
      derived.push(messages.map((message) => textOf(message.content)).join("\n"));
      continue;
    }
    for (const message of messages) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      for (const block of message.content as { type?: string; id?: string; name?: string }[]) {
        if (block?.type === "toolCall" && block.id !== undefined && block.name !== undefined)
          callNames.set(block.id, block.name);
      }
    }
    for (const message of messages) {
      if (message.role === "toolResult") {
        const name = message.toolName ?? callNames.get(String(message.toolCallId)) ?? "";
        if (VAULT_TOOLS.includes(name)) vault.push(textOf(message.content));
        else if (isOutside(name)) outside.push(textOf(message.content));
      }
    }
    const user = messages.find((message) => message.role === "user");
    if (user !== undefined) {
      const content = textOf(user.content);
      origin = originOfPrefix(content);
      ownerInput = origin === "owner" ? content : "";
      inputAt = user.timestamp ?? 0;
      break scan;
    }
  }
  // This conversation's own trail, never a global tail other bots can flush.
  const events = (deps.audit?.ofConversation(conversationId) ?? []).filter(
    (event) => event.at >= inputAt,
  );
  return {
    origin,
    ownerInput,
    inputAt,
    outside,
    vault,
    derived,
    outsideCalls: events.filter((event) => isOutside(String(event.name))).length,
    learned: events.reduce((sum, event) => {
      if (event.ok !== true) return sum;
      if (event.name === SKILL_LEARN || event.name === SKILL_WRITE) return sum + 1;
      // A skill_edit batch is one save per op; its audit event carries the count.
      return event.name === SKILL_EDIT ? sum + (event.saves ?? 1) : sum;
    }, 0),
    outsideTask,
  };
};

/** What the shared check says about one skill save. */
export type SkillGate =
  | { readonly kind: "ok" }
  | { readonly kind: "refuse"; readonly reason: string }
  /** skill_write only: the owner decides on a card. */
  | { readonly kind: "ask"; readonly reason: string };

const LEARNING_OFF =
  "learning is off for this bot: your owner turned it off; ask before writing skills";

/**
 * The one check both skill-writing tools run. Content rules (cap, unreadable
 * outside content, secrets, approval talk, vault values, copied or planted
 * outside text) refuse either tool. Who-is-asking rules refuse skill_learn
 * and send skill_write to the owner: learning off, or a turn the owner didn't
 * start (for skill_learn, cron and task turns are its own work and pass).
 */
export const skillGate = (
  tool: "learn" | "write",
  text: string,
  turn: TurnContext,
  learning: boolean,
): SkillGate => {
  const ownWork = turn.origin === "owner" || turn.origin === "cron" || turn.origin === "task";
  if (tool === "learn") {
    if (!learning) return { kind: "refuse", reason: LEARNING_OFF };
    if (turn.outsideTask === true)
      return {
        kind: "refuse",
        reason:
          "refused: this background task was started or steered from a turn with outside content, so it doesn't learn skills on its own",
      };
    if (!ownWork)
      return {
        kind: "refuse",
        reason: `refused: this turn came from outside (${turn.origin}); skills are learned from your owner's turns and your own scheduled work`,
      };
  }
  const content = contentRefusal(text, turn);
  if (content !== null) return { kind: "refuse", reason: content };
  if (tool === "write" && !learning)
    return {
      kind: "ask",
      reason: "Learning is off for this bot, so this skill write needs your OK.",
    };
  if (tool === "write" && turn.outsideTask === true)
    return {
      kind: "ask",
      reason:
        "This background task was started or steered from a turn with outside content, so this skill write needs your OK.",
    };
  if (tool === "write" && turn.origin !== "owner")
    return {
      kind: "ask",
      reason: `This turn wasn't started by you (${turn.origin}), so this skill write needs your OK.`,
    };
  return { kind: "ok" };
};

/** Why this text can't be learned this turn, or null when it can. */
export const learnRefusal = (body: string, turn: TurnContext): string | null => {
  const gate = skillGate("learn", body, turn, true);
  return gate.kind === "refuse" ? gate.reason : null;
};

/**
 * Why a skill_edit batch of `ops` can't run this turn, or undefined to go
 * ahead: a batch is exactly the mass-save vector the cap exists for, so
 * every op counts against the remaining allowance and a batch over it is
 * refused wholesale.
 */
export const batchAllowanceRefusal = (learned: number, ops: number): string | undefined => {
  const remaining = MAX_LEARNED_PER_TURN - learned;
  return ops > remaining
    ? `refused: this batch carries ${ops} ops but only ${remaining} of the ` +
        `${MAX_LEARNED_PER_TURN} skill saves left this turn remain; send fewer ops ` +
        "or save the rest on a later turn"
    : undefined;
};

/** The content rules alone (see skillGate). */
const contentRefusal = (body: string, turn: TurnContext): string | null => {
  if (turn.learned >= MAX_LEARNED_PER_TURN)
    return `refused: ${MAX_LEARNED_PER_TURN} skills saved this turn already; save more on a later turn`;
  if (turn.outsideCalls > turn.outside.length)
    return "refused: this turn read outside content I can't check; learn it on a turn that didn't";
  const secret = secretIn(body);
  if (secret !== null) return `refused: the text looks like it contains ${secret}`;
  const content = checkContent(body);
  if (!content.ok) return "refused: the text looks like it holds a secret, card, ID or code";
  if (APPROVAL_TALK.test(body))
    return "refused: a skill can't say what needs approval or change permissions; that's your owner's approval settings";
  const vaultTokens = new Set(turn.vault.flatMap((text) => [...tokensOf(text)]));
  if (
    [...tokensOf(body)].some((token) => vaultTokens.has(token)) ||
    sharesRun(body, turn.vault, VAULT_RUN)
  )
    return "refused: the text holds values from the vault; skills never carry them";
  const unowned = [...turn.outside, ...(turn.derived ?? [])];
  if (sharesRun(body, unowned, COPY_RUN))
    return "refused: the text copies outside content from this turn (a page, document, mail or file); write the procedure in your own words, from what your owner asked";
  const ownerTokens = tokensOf(turn.ownerInput);
  const outsideTokens = new Set(unowned.flatMap((text) => [...tokensOf(text)]));
  const planted = [...tokensOf(body)].find(
    (token) => outsideTokens.has(token) && !ownerTokens.has(token),
  );
  if (planted !== undefined)
    return "refused: the text carries an address, link or number from outside content this turn that your owner didn't give you";
  return null;
};

/** Whether this bot learns skills on its own (default on). */
export const learningOn = (profiles: ProfilesService, conversationId: string): boolean =>
  profiles.profileOf(conversationId)?.policies.learnSkills !== false;

/** What learning reads per call: the transcript, the audit trail, MCP taint. */
export interface LearnDeps {
  readonly profiles: ProfilesService;
  readonly converse: ConverseService;
  readonly audit?: AuditService | undefined;
  readonly untrustedTool?: ((name: string) => boolean) | undefined;
  readonly tasks?: Pick<TasksService, "taskOf"> | undefined;
}

/** One skill_write as the gate sees it: the body and every reference file. */
export interface SkillWriteInput {
  readonly name: string;
  readonly body: string;
  readonly files?: readonly { readonly path: string; readonly content: string }[] | undefined;
}

/**
 * skill_write's guard: the same gate as skill_learn over the body and every
 * reference file. Returns a refusal for the model, or undefined to write. An
 * "ask" parks an owner-only card (no auto-approve rule, Jev or YOLO answers
 * it); without an approval surface it refuses.
 */
export const skillWriteGuard =
  (deps: LearnDeps & { readonly approvals?: ApprovalsService | undefined }) =>
  async (
    input: SkillWriteInput,
    api: { readonly conversationId: unknown; readonly callId: unknown },
  ): Promise<string | undefined> => {
    const conversationId = String(api.conversationId);
    const callId = String(api.callId);
    const turn = await turnContext(deps, conversationId);
    const text = [input.body, ...(input.files ?? []).map((f) => `${f.path}\n${f.content}`)].join(
      "\n",
    );
    const gate = skillGate("write", text, turn, learningOn(deps.profiles, conversationId));
    if (gate.kind === "ok") return undefined;
    if (gate.kind === "refuse") return gate.reason;
    if (deps.approvals === undefined) return `refused: ${gate.reason} There is no one to ask here.`;
    const approved = await Effect.runPromise(
      deps.approvals.request(
        conversationId,
        callId,
        {
          callId,
          name: SKILL_WRITE,
          description: gate.reason,
          input: { name: input.name, body: input.body, files: input.files ?? [] },
        },
        { owner: true },
      ),
    );
    if (approved) return undefined;
    return (
      deps.approvals.noteFor(conversationId, callId) ??
      "not approved: your owner said no to this skill write (or didn't answer); don't retry, tell them what wasn't saved"
    );
  };

const fail = (text: string) => ({
  output: [{ type: "text" as const, text }],
  isError: true as const,
});

export const learnTool = (deps: LearnDeps & { readonly skills: SkillsService }): Tool =>
  defineTool({
    name: SKILL_LEARN,
    description:
      "Save what this turn taught you as a skill, on your own: a repeatable procedure you just " +
      "worked out, or a correction your owner gave you. No approval: your owner sees " +
      '"learned: <lesson>" and can undo it in one tap. Write in your own words. Make the ' +
      'description\'s first sentence a use-trigger ("Use when …"): that sentence is what the ' +
      "skill list shows. When the save carries extra files, use the layout folders: " +
      "references/ for docs, templates/ for copy starters, scripts/ for runnable code, " +
      "assets/ for static bytes. Never copy " +
      "outside content (pages, documents, mail, files), secrets, contact details or anything " +
      `about approvals into a skill; those are refused. At most ${MAX_LEARNED_PER_TURN} per turn. ` +
      "Updating a skill replaces its whole text, so load it first.",
    parameters: obj(
      {
        name: str({
          description: "The skill's name: lowercase-and-hyphens, new or existing.",
        }),
        lesson: str({
          description: `What you learned, one line (at most ${MAX_LESSON_CHARS} characters), for your owner.`,
        }),
        body: str({ description: "The skill's full text (SKILL.md, frontmatter optional)." }),
        description: opt(str({ description: "When to use it, if the body has no frontmatter." })),
      },
      { open: true },
    ),
    execute: async (args, api) => {
      const conversationId = String(api.conversationId);
      const resolved = skillsScope(deps.profiles, conversationId);
      if ("refused" in resolved) return fail(resolved.refused);
      if (!learningOn(deps.profiles, conversationId)) return fail(LEARNING_OFF);
      if (!slugOk(args.name))
        return fail(`"${args.name}" is not a skill name (lowercase-and-hyphens)`);
      const lesson = args.lesson.replace(/\s+/g, " ").trim().slice(0, MAX_LESSON_CHARS);
      if (lesson === "") return fail("say what you learned in `lesson`");
      let body = args.body;
      if (parseSkillDoc(body) === undefined) {
        if (args.description === undefined)
          return fail("the body needs frontmatter (name, description) or pass `description`");
        body = serializeSkillDoc(args.name, args.description, body);
      }
      if (body.length > MAX_SKILL_CHARS)
        return fail(`the skill is over ${MAX_SKILL_CHARS} characters`);
      const turn = await turnContext(deps, conversationId);
      const gate = skillGate("learn", `${body}\n${lesson}`, turn, true);
      if (gate.kind !== "ok") return fail(gate.reason);
      const { owner, profileId } = resolved.scope;
      const existing = await deps.skills.read(owner, profileId, args.name);
      try {
        const meta = await deps.skills.write(owner, profileId, {
          name: args.name,
          body,
          by: "learning",
          turn: `${conversationId}#${String(api.callId)}`,
          note: `learned: ${lesson}`,
          ...(existing === undefined
            ? { origin: "self" as const, authorProfile: profileId }
            : { origin: existing.meta.origin, authorProfile: existing.meta.authorProfile }),
        });
        return {
          output: [
            {
              type: "text" as const,
              text: `learned: ${lesson} (skill "${meta.name}" v${meta.version}; your owner can undo it)`,
            },
          ],
          details: { profile: profileId, skill: meta.name, version: meta.version, lesson },
          structuredOutput: { name: meta.name, version: meta.version },
        };
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

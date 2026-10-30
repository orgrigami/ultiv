/**
 * The Converse faculty: durable conversations over the pi-durable harness.
 * `turn` — submit -> wait -> commit — is the ONLY path an input reaches a
 * model (owner rule: no raw provider calls). The harness is a scoped
 * resource of this layer: closing the layer closes the harness.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Context, Effect, Layer } from "effect";
import { ConfigError } from "effect/Config";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  AssistantEntry,
  defineDocFamily,
  Harness,
  type AgentChange,
  type Conversation,
  type EntryRecord,
  type InputEntry,
  type JsonObject,
  type LiveState,
  type ConversationId,
  type SessionDocFamilyToken,
  type SessionDocToken,
  type Storage,
  type Submission,
  type Tx,
  type UserInput,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { External } from "@ultiv/core";
import { harnessDb } from "../config.ts";
import { asEffect } from "./as-effect.ts";
import { controlOps } from "./control.ts";
import { selectionOps } from "./selection.ts";
import { PiRegistry } from "./pi-registry.ts";
import { MindModels, ModelCatalog } from "../providers/models.ts";
import { parseRef, type ModelSpec } from "../providers/refs.ts";

export interface TurnResult {
  /** The committed assistant text; empty when the turn produced none. */
  readonly text: string;
}

/** The conversation's current model/effort selection; null = the mind's default. */
export interface AgentSelection {
  readonly model: string | null;
  readonly effort: ModelThinkingLevel | null;
}

export interface ConverseService {
  /** The reserved root conversation (probes, background jobs). */
  readonly root: () => Effect.Effect<Conversation, External>;
  /** Resolve the durable conversation behind an app key, creating and mapping it on first use. */
  readonly ensure: (
    key: string,
    /** Agent override applied when the conversation is created (profiles: model + allowlist). */
    agent?: AgentChange,
  ) => Effect.Effect<Conversation, External>;
  /** Open an existing durable conversation by id; undefined when there is none. */
  readonly open: (id: string) => Effect.Effect<Conversation | undefined, External>;
  /** Admit an input into the durable transcript (visibility = durability). */
  readonly submit: (
    conversation: Conversation,
    content: UserInput,
    /** When a turn is in flight: steer it at the next boundary, queue as follow-up, or reject. */
    whenBusy?: "steer" | "followUp" | "reject",
    /** Idempotency key: a repeat with the same id returns the first submission. */
    requestId?: string,
    /** Place the input as this entry (attachment metadata); default `pi.user`. */
    entry?: InputEntry,
  ) => Effect.Effect<Submission, External>;
  /**
   * Append a passive app entry (never a model input, never wakes a turn):
   * lands at once, even mid-run. The kind must not start with `pi.`.
   */
  readonly write: (
    conversation: Conversation,
    kind: string,
    data: JsonObject,
  ) => Effect.Effect<void, External>;
  /** Stop the conversation's current turn: withdraw queued inputs, abort, wait for idle. */
  readonly interrupt: (conversation: Conversation) => Effect.Effect<void, External>;
  /** The conversation's `pi.live` doc: `run` is present exactly while a turn works. */
  readonly liveOf: (conversation: Conversation) => Effect.Effect<LiveState | undefined, External>;
  /**
   * Abort only the running turn (Redirect now): the partial reply is kept as
   * interrupted, running tools end with an `aborted` result, queued messages
   * stay queued. Resolves once the conversation is idle.
   */
  readonly abortRun: (conversation: Conversation) => Effect.Effect<"idle" | "aborted", External>;

  /** Take back one queued submission before a boundary places it. */
  readonly withdraw: (
    conversation: Conversation,
    submissionId: string,
  ) => Effect.Effect<"aborted" | "already_placed" | "settled" | "not_found", External>;
  /** The app key -> conversation mapping, read-only: undefined when unmapped. */
  readonly conversationIdOf: (key: string) => Effect.Effect<string | undefined, External>;
  /** Settle an admitted submission: wait for the agent, commit the assistant entry. */
  readonly settle: (
    conversation: Conversation,
    submission: Submission,
  ) => Effect.Effect<TurnResult, External>;
  /** One admitted turn: submit -> settle. The only path an input reaches a model. */
  readonly turn: (
    conversation: Conversation,
    content: UserInput,
    /** When a turn is in flight: steer it at the next boundary, queue as follow-up, or reject. */
    whenBusy?: "steer" | "followUp" | "reject",
  ) => Effect.Effect<TurnResult, External>;
  /** The conversation's current model/effort selection. */
  readonly agentOf: (conversation: Conversation) => Effect.Effect<AgentSelection, External>;
  /**
   * Apply a model/effort selection to a conversation — durable, in the
   * conversation's own commit. Partial: absent fields stay unchanged; null
   * resets a field to the mind's default.
   */
  readonly configure: (
    conversation: Conversation,
    selection: {
      readonly model?: string | null;
      readonly effort?: ModelThinkingLevel | null;
      /** The tool set (an allowlist or sandbox exclusion); null clears the override. */
      readonly tools?: AgentChange["tools"];
    },
  ) => Effect.Effect<void, External>;
  /** The raw transcript entries of one conversation, newest first (history search). */
  readonly entriesOf: (
    conversationId: string,
    limit: number,
  ) => Effect.Effect<readonly EntryRecord[], External>;
  /** App-level durable documents ride the same harness storage. */
  readonly docs: {
    readonly snapshot: <T extends JsonObject>(
      doc: SessionDocToken<T>,
    ) => Effect.Effect<T | undefined, External>;
    /** Family-doc snapshot by seed key (doc families). */
    readonly snapshotKeyed: <T extends JsonObject>(
      doc: SessionDocFamilyToken<T, T>,
      key: string,
    ) => Effect.Effect<T | undefined, External>;
    readonly commit: <T>(change: (tx: Tx) => T | Promise<T>) => Effect.Effect<T, External>;
  };
}

export class Converse extends Context.Service<Converse, ConverseService>()("ultiv/mind/Converse") {}

/** Durable session-key -> conversation mapping (kind preserved: pre-existing SQLite data). */
const SessionMapDoc = defineDocFamily<
  { conversationId: ConversationId },
  { conversationId: ConversationId }
>({
  kind: "ultiv.session-map",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed) => ({ conversationId: seed.conversationId }),
  checkpointWhen: () => true,
});

/** Resolve the durable conversation behind an app key, creating and mapping it on first use. */
const ensureConversation = (
  harness: Harness,
  key: string,
  agent: AgentChange,
  agentOverride?: AgentChange,
) =>
  Effect.gen(function* () {
    const known = yield* asEffect(
      "session map read",
      harness.snapshot(SessionMapDoc, key, BACKGROUND_CONTEXT),
    );
    if (known) {
      const existing = yield* asEffect(
        "conversation open",
        harness.conversation(known.conversationId, BACKGROUND_CONTEXT),
      );
      if (existing) return existing;
    }
    const created = yield* asEffect(
      "conversation create",
      harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: agentOverride ?? agent },
        BACKGROUND_CONTEXT,
      ),
    );
    yield* asEffect(
      "session map write",
      harness.commit(async (tx) => {
        const draft = await tx.doc(SessionMapDoc, key, { conversationId: created.id });
        draft.conversationId = created.id;
      }, BACKGROUND_CONTEXT),
    );
    return created;
  });

/** One admitted turn: submit -> wait -> commit. */
const submitOf = (
  conversation: Conversation,
  content: UserInput,
  whenBusy?: "steer" | "followUp" | "reject",
  requestId?: string,
  entry?: InputEntry,
): Effect.Effect<Submission, External> =>
  asEffect(
    "submit",
    conversation.submit(
      {
        type: "input",
        content,
        ...(whenBusy !== undefined ? { whenBusy } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        ...(entry !== undefined ? { entry } : {}),
      },
      BACKGROUND_CONTEXT,
    ),
  );

const settleOf = (
  conversation: Conversation,
  submission: Submission,
): Effect.Effect<TurnResult, External> =>
  Effect.gen(function* () {
    const settled = yield* asEffect("agent wait", submission.wait(BACKGROUND_CONTEXT));
    if (settled.status !== "done" || settled.type !== "input") {
      return yield* new External({
        op: "agent turn",
        cause: `agent unanswered: ${JSON.stringify(settled).slice(0, 200)}`,
      });
    }
    const stored = yield* asEffect(
      "commit",
      conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT),
    );
    const message = stored?.model?.[0] as { content?: unknown } | undefined;
    return { text: textOf(message?.content) };
  });

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => String((block as { text?: string }).text ?? "")).join("");
  }
  return JSON.stringify(content);
}

/** Conversation ids are numeric today; accept any string form losslessly. */
const conversationIdFrom = (id: string): ConversationId => {
  const numeric = Number(id);
  return (Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : id) as unknown as ConversationId;
};

/** Exported for engine-level tests (faux models, MemoryStorage). */
export const converseService = (
  harness: Harness,
  agent: AgentChange,
  /** The catalog lookup selection reads efforts from; none in engine tests. */
  findModel: (ref: string) => ModelSpec | undefined = () => undefined,
): ConverseService => ({
  root: () => asEffect("root conversation", harness.root(BACKGROUND_CONTEXT, { agent })),
  ensure: (key, agentOverride) => ensureConversation(harness, key, agent, agentOverride),
  open: (id) =>
    asEffect("conversation open", harness.conversation(conversationIdFrom(id), BACKGROUND_CONTEXT)),
  ...controlOps(harness),
  conversationIdOf: (key) =>
    Effect.map(
      asEffect("session map read", harness.snapshot(SessionMapDoc, key, BACKGROUND_CONTEXT)),
      (known) => known?.conversationId as unknown as string | undefined,
    ),
  entriesOf: (conversationId, limit) =>
    Effect.flatMap(
      asEffect(
        "conversation open",
        harness.conversation(conversationIdFrom(conversationId), BACKGROUND_CONTEXT),
      ),
      (conversation) =>
        conversation === undefined
          ? Effect.succeed([] as readonly EntryRecord[])
          : Effect.map(
              asEffect(
                "entries scan",
                conversation.entries({}, limit, undefined, BACKGROUND_CONTEXT),
              ),
              (page) => page.items,
            ),
    ),
  submit: (conversation, content, whenBusy, requestId, entry) =>
    submitOf(conversation, content, whenBusy, requestId, entry),
  settle: (conversation, submission) => settleOf(conversation, submission),
  write: (conversation, kind, data) =>
    Effect.asVoid(
      asEffect(
        "write",
        conversation.submit({ type: "write", entry: { kind, data } }, BACKGROUND_CONTEXT),
      ),
    ),
  turn: (conversation, content, whenBusy) =>
    Effect.flatMap(submitOf(conversation, content, whenBusy), (submission) =>
      settleOf(conversation, submission),
    ),
  ...selectionOps(findModel),
  docs: {
    // The token is family-parametric; the harness call is typed once at this boundary.
    snapshot: <T extends JsonObject>(doc: SessionDocToken<T>) =>
      asEffect(
        "doc read",
        harness.snapshot(doc as SessionDocToken<JsonObject>, BACKGROUND_CONTEXT),
      ) as Effect.Effect<T | undefined, External>,
    snapshotKeyed: <T extends JsonObject>(doc: SessionDocFamilyToken<T, T>, key: string) =>
      asEffect(
        "doc read",
        harness.snapshot(doc as never, key, BACKGROUND_CONTEXT),
      ) as Effect.Effect<T | undefined, External>,
    commit: (change) => asEffect("doc commit", harness.commit(change, BACKGROUND_CONTEXT)),
  },
});

const openSqlite: Effect.Effect<Storage, External | ConfigError> = Effect.gen(function* () {
  const path = yield* harnessDb;
  yield* Effect.try({
    try: () => mkdirSync(dirname(path), { recursive: true }),
    catch: (cause) => new External({ op: `mkdir ${path}`, cause }),
  });
  return yield* asEffect("open storage", openNodeSqliteStorage(path));
});

/**
 * The Converse faculty. Storage overrides come from `openMind`; the model
 * catalog and the pi-durable registry are the mind's own. The act's tool
 * extension, codemode, and the task tools are installed into that registry by
 * the entity (see `entity.ts`) — pi-durable registries may keep changing
 * while the harness runs, so late installs reach every conversation.
 */
export const converseLayer = (
  storage: Storage | undefined,
): Layer.Layer<Converse, External | ConfigError, MindModels | ModelCatalog | PiRegistry> =>
  Layer.effect(
    Converse,
    Effect.gen(function* () {
      const models = yield* MindModels;
      const piRegistry = yield* PiRegistry;
      const catalog = yield* ModelCatalog;
      const resolvedStorage = yield* storage !== undefined ? Effect.succeed(storage) : openSqlite;
      const harness = yield* Effect.acquireRelease(
        asEffect(
          "open harness",
          Harness.open(
            resolvedStorage,
            {
              models,
              registry: piRegistry,
              // Every steer queued during a step lands at the next boundary together.
              // Read at every resolution: thresholds follow catalog refreshes.
              settings: {
                get compaction() {
                  return catalog.compaction();
                },
                steeringMode: "all",
              },
            },
            BACKGROUND_CONTEXT,
          ),
        ),
        (harness) => Effect.ignore(asEffect("close harness", harness.close(BACKGROUND_CONTEXT))),
      );
      return converseService(harness, { model: parseRef(catalog.defaultRef()) }, catalog.find);
    }),
  );

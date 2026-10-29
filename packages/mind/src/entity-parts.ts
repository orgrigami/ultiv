/**
 * The entity's composition parts, split out of entity.ts: the routine
 * services, the late pi-registry installs, the approval policy and the
 * describe() truth. Each profile runs as its own entity over these.
 */
import { Effect } from "effect";
import { defineExtension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ScopeHolder } from "@ultiv/ext";
import type { TranscriptEntry } from "@ultiv/contracts";
import type { ApprovalRequest, ApprovalsService } from "./approvals.ts";
import { mayAutoApprove } from "./auto-approve.ts";
import { CONTEXT_ENTRIES, isApprovalFloor, makeAdjudicator } from "./jev-gate.ts";
import { projectTranscript } from "./converse/steps.ts";
import type { actService } from "./act/act.ts";
import { codemodeExtension } from "./act/codemode.ts";
import { taskTools } from "./act/task-tools.ts";
import { ENTITY_NAME } from "./act/identity.ts";
import { runningTasksSection } from "./act/task-live.ts";
import { skillsExtension } from "./skills/section.ts";
import type { SkillsService } from "./skills/service.ts";
import type { AuditService } from "./audit/audit.ts";
import type { ConverseService } from "./converse/converse.ts";
import type { TasksService } from "./tasks/tasks.ts";
import type { ProfilesService } from "./profiles/profiles.ts";
import { profilesExtension, memoryCoreExtension } from "./profiles/section.ts";
import type { RoomsService } from "./profiles/rooms.ts";
import type { MailboxService } from "./mailbox/mailbox.ts";
import { messageTools } from "./mailbox/tools.ts";
import { memoryService, type MemoryService } from "./memory/memory.ts";
import { memoryTools } from "./memory/tools.ts";
import { historyService, type HistoryService } from "./history/history.ts";
import { historyTools } from "./history/tools.ts";
import { schedulesService, type SchedulesService } from "./schedules/schedules.ts";
import { scheduleTools } from "./schedules/tools.ts";
import { receiptsService, type ReceiptsService } from "./routines/receipts.ts";
import { webhooksService, type WebhooksService } from "./webhooks/webhooks.ts";
import { webhookTools } from "./webhooks/tools.ts";
import { kvService, type KvService } from "./state/kv.ts";
import { stateTools } from "./state/tools.ts";
import { sensorsService, type SensorsService } from "./sensors/sensors.ts";
import { sensorTools } from "./sensors/tools.ts";
import type { GenerateService } from "./generate/generate.ts";
import type { DecideService } from "./decide/decide.ts";

/** The services whose tools ride the pi-durable registry as late installs. */
interface Faculties {
  readonly converse: ConverseService;
  readonly act: ReturnType<typeof actService>;
  readonly tasks: TasksService;
  readonly profiles: ProfilesService;
  readonly rooms: RoomsService;
  readonly mailbox: MailboxService;
  readonly memory: MemoryService;
  readonly schedules: SchedulesService;
  readonly receipts: ReceiptsService;
  readonly webhooks: WebhooksService;
  readonly state: KvService;
  readonly sensors: SensorsService;
  readonly history: HistoryService;
  /** The write guard reads the turn's origin and taint through these. */
  readonly audit?: AuditService;
  /** The approval surface, for the skills extension's gated tools. */
  readonly approvals?: ApprovalsService;
  /** Names beyond the guard's base set that taint a turn (installed MCP tools). */
  readonly untrustedTool?: (name: string) => boolean;
  /** bots_list / bot_info: read-only sibling discovery, in the allowlist universe. */
  readonly botTools: readonly ToolRegistration[];
  /** The skills faculty: built-in and self-written procedures, per profile. */
  readonly skills?: SkillsService;
}

/** Late installs are legal: the harness reconsiders its tools as the registry changes. */
export const installFaculties = (
  piRegistry: { readonly install: (extension: ReturnType<typeof defineExtension>) => void },
  f: Faculties,
): void => {
  const { act, tasks, profiles, rooms, mailbox, memory, schedules, receipts } = f;
  const { webhooks, state, sensors, history } = f;
  piRegistry.install(act.extension());
  piRegistry.install(codemodeExtension());
  piRegistry.install(profilesExtension(profiles, ENTITY_NAME));
  piRegistry.install(memoryCoreExtension(memory, profiles));
  if (f.skills !== undefined) {
    piRegistry.install(
      skillsExtension({
        skills: f.skills,
        profiles,
        tasks,
        ...(f.approvals !== undefined ? { approvals: f.approvals } : {}),
        ...(f.audit !== undefined ? { audit: f.audit } : {}),
      }),
    );
  }
  piRegistry.install(defineExtension({ name: "ultius.mind.bots", tools: [...f.botTools] }));
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.tasks",
      tools: taskTools(tasks, profiles),
      sections: [runningTasksSection(tasks, profiles)],
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.mailbox",
      tools: messageTools(mailbox, profiles, rooms),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.memory",
      tools: memoryTools(memory, profiles, {
        converse: f.converse,
        ...(f.audit !== undefined ? { audit: f.audit } : {}),
        ...(f.untrustedTool !== undefined ? { untrustedTool: f.untrustedTool } : {}),
      }),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.schedules",
      tools: scheduleTools(schedules, profiles),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.webhooks",
      tools: webhookTools(webhooks, receipts, profiles),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.state",
      tools: stateTools(state, profiles),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.sensors",
      tools: sensorTools(sensors, profiles),
    }),
  );
  piRegistry.install(
    defineExtension({
      name: "ultius.mind.history",
      tools: historyTools(history, profiles),
    }),
  );
};

/** Compact transcript tail for the reason prompt: what the bot was up to. */
const reasonContext = (entries: readonly TranscriptEntry[]): string =>
  entries
    .slice(-6)
    .map((entry) => {
      if (entry.kind === "tool") {
        return `tool ${entry.step.name}: ${JSON.stringify(entry.step.input).slice(0, 160)}`;
      }
      return `${entry.kind}: ${entry.text.slice(0, 200)}`;
    })
    .join("\n");

/**
 * The card's reason: one model sentence on what the parked call does and why.
 * Best-effort by construction — any failure leaves the card without a reason.
 */
export const makeDescriber =
  (
    generate: GenerateService,
    converse: ConverseService,
    profiles: ProfilesService,
  ): ((conversationId: string, request: ApprovalRequest) => Promise<string | undefined>) =>
  async (conversationId, request) => {
    const profile = profiles.profileOf(conversationId);
    if (profile === undefined) return undefined;
    const recent = await Effect.runPromise(
      Effect.map(converse.entriesOf(conversationId, 6), (entries) =>
        projectTranscript([...entries].reverse(), undefined, false),
      ),
    ).catch(() => []);
    const context = reasonContext(recent);
    const prompt = [
      `A gated tool call is waiting for the owner's approval.`,
      `Tool: ${request.name}${
        request.description !== undefined && request.description !== ""
          ? ` — ${request.description.slice(0, 200)}`
          : ""
      }`,
      `Input: ${JSON.stringify(request.input).slice(0, 600)}`,
      context !== "" ? `Recent transcript:\n${context}` : "No prior conversation.",
      "Write ONE short sentence (max 25 words) for the approval card: what this call does and why the bot is doing it. Plain text, no quotes.",
    ].join("\n\n");
    const reason = await Effect.runPromise(
      generate.complete({
        system: "You write one-line reasons for approval cards. Plain text only.",
        prompt,
        maxTokens: 80,
      }),
    ).catch(() => undefined);
    return reason === undefined ? undefined : reason.trim().slice(0, 200) || undefined;
  };

/**
 * Profile scoping for the ext plugins and the per-profile approval policy.
 * `decide` is the Jev faculty: it powers the 'jev' approval mode's gate.
 * `generate`, when present, writes the reason line on pending approval cards.
 */
export const wirePolicies = (
  holder: ScopeHolder,
  approvals: ApprovalsService,
  audit: AuditService,
  profiles: ProfilesService,
  decide: DecideService,
  converse: ConverseService,
  generate?: GenerateService,
): void => {
  // Profile scoping reaches the ext plugins (artifacts dirs, vault lists)
  // through the holder the registry was built with — set now that the
  // conversation→profile index exists.
  holder.set({
    scopeOf: (conversationId) => {
      const scope = profiles.scopeOf(conversationId);
      return scope === undefined ? undefined : { owner: scope.owner, profile: scope.profileId };
    },
  });
  // Per-profile approval policy (auto-approve lists, Jev gate, timeout
  // escalation). The hard floors stand whatever the mode says.
  approvals.setHooks({
    // A credential's first use on a host, and a connector's first use, are
    // always asked, whatever the list says. Entries are tool names or
    // `tool:glob` sub-action patterns (see auto-approve.ts): a bare name is
    // the owner's whole-tool grant; a pattern match is refused when the
    // matched text crosses a command boundary or the call looks destructive,
    // and the privileged bash_host never pattern-matches.
    autoApprove: (conversationId, request) => {
      const profile = profiles.profileOf(conversationId);
      const mode = profile?.policies.approvalMode;
      if (isApprovalFloor(request.name)) return false;
      if (mode === "yolo") return true;
      return mayAutoApprove(profile?.policies.autoApprove ?? [], request);
    },
    // 'jev': floors and bash_host always reach the owner; see jev-gate.ts.
    adjudicate: makeAdjudicator({
      decide,
      record: (event) => audit.record(event),
      profileOf: (conversationId) => profiles.profileOf(conversationId),
      transcript: (conversationId) =>
        Effect.map(converse.entriesOf(conversationId, CONTEXT_ENTRIES), (entries) =>
          projectTranscript([...entries].reverse(), undefined, false),
        ),
    }),
    onExpire: (conversationId, request) => {
      audit.record({
        at: Date.now(),
        kind: "escalation",
        conversationId,
        profile: profiles.profileOf(conversationId)?.id ?? null,
        callId: request.callId,
        name: request.name,
        durationMs: null,
        ok: false,
        error: "approval timed out",
      });
    },
    ...(generate !== undefined ? { describe: makeDescriber(generate, converse, profiles) } : {}),
  });
};

/** The truth: registry plugins AND the late pi-registry installs act.tools() misses. */
export const describeMind = (
  act: ReturnType<typeof actService>,
  decide: DecideService,
  piRegistry: {
    readonly snapshot: () => {
      readonly tools: () => ReadonlyArray<{ readonly tool: { readonly name: string } }>;
    };
  },
) => ({
  entity: ENTITY_NAME,
  decide: decide.available,
  tools: [
    ...new Set([
      ...act.tools().map((tool) => tool.name),
      ...piRegistry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
    ]),
  ],
});

/** The per-profile routine services (memory, history, schedules, triggers, state). */
export const routineServices = (
  converse: ConverseService,
  profiles: ProfilesService,
  onSchedulesChanged: (() => Promise<void>) | undefined,
  models: {
    /** The extraction/decision models for the memory v2 write pipeline. */
    readonly generate?: GenerateService;
    readonly decide?: DecideService;
    /** Taint sources for the memory write/forget guard. */
    readonly audit?: AuditService;
    readonly untrustedTool?: (name: string) => boolean;
  } = {},
) => ({
  memory: memoryService({ converse, profiles, ...models }),
  history: historyService({ converse, profiles }),
  schedules: schedulesService({
    converse,
    profiles,
    ...(onSchedulesChanged !== undefined ? { onChanged: onSchedulesChanged } : {}),
  }),
  receipts: receiptsService({ converse }),
  webhooks: webhooksService({ converse, profiles }),
  state: kvService({ converse }),
  sensors: sensorsService({ converse, profiles }),
});

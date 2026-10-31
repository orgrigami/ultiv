/**
 * The mind — the entity substrate (`@spreissen/mind` keeps its working package
 * name). One runtime hosts many entities: EACH PROFILE (bot) IS ITS OWN
 * ENTITY, with its own persona, memory, artifacts, vault scope, tool
 * allowlist and audit trail; the default profile is **Ultius**. Chat is only
 * one form of an entity: `converse` (durable conversations, Redirect now),
 * `decide` (typed Jev decisions, independent of chat), `act` (the executable
 * tool surface: codemode, background tasks, the `http_request` credential
 * broker), `generate` (one-shot app-facing completion), `mailbox` (bot-to-bot
 * rooms with deadlines) and `audit` (what each entity did). Everything enters
 * through this service; nothing reaches a provider raw.
 */
import { Context, Effect, Layer } from "effect";
import { ConfigError } from "effect/Config";
import { type Storage, type ToolRegistration } from "@earendil-works/pi-durable";
import { openRuntime, Duplicate, External, Unavailable, type Runtime } from "@spreissen/core";
import {
  artifactsPlugin,
  bashPlugin,
  calendarConfigured,
  calendarPlugin,
  createScopeHolder,
  emailConfigured,
  emailPlugin,
  makeRegistry,
  Registry,
  tinyfishConfigured,
  tinyfishPlugin,
  vaultConfigured,
  vaultDir,
  makeVaultStore,
  vaultPlugin,
  makeBindingStore,
  type BindingStore,
  type McpManager,
  type Plugin,
  type VaultStore,
} from "@spreissen/ext";
import { Approvals, approvalsLayer, type ApprovalsService } from "./approvals.ts";
import { actService } from "./act/act.ts";
import { tasksVisibleTo } from "./act/task-live.ts";
import type { ScopeHolder } from "@spreissen/ext";
import { decisionPlugin } from "./act/decision-tools.ts";
import { brokerFor } from "./act/broker.ts";
import { describeMind, installFaculties, routineServices, wirePolicies } from "./entity-parts.ts";
import { temporalPlugin } from "./act/temporal.ts";
import { Audit, auditLayer, type AuditService } from "./audit/audit.ts";
import { Converse, converseLayer, type ConverseService } from "./converse/converse.ts";
import { PiRegistry, piRegistryLayer } from "./converse/pi-registry.ts";
import { Tasks, MAX_RUNNING_TASKS, tasksLayer, type TasksService } from "./tasks/tasks.ts";
import { profilesService, type ProfilesService } from "./profiles/profiles.ts";
import { botsTools, taskActivity } from "./profiles/bots-tools.ts";
import { botCreateTools } from "./profiles/bot-create.ts";
import { roomsService, type RoomsService } from "./profiles/rooms.ts";
import { mailboxService, type MailboxService } from "./mailbox/mailbox.ts";
import { skillsService, type SkillsService } from "./skills/service.ts";
import { type MemoryService } from "./memory/memory.ts";
import { type HistoryService } from "./history/history.ts";
import { type SchedulesService } from "./schedules/schedules.ts";
import { type ReceiptsService } from "./routines/receipts.ts";
import { type WebhooksService } from "./webhooks/webhooks.ts";
import { type KvService } from "./state/kv.ts";
import { type SensorsService } from "./sensors/sensors.ts";
import {
  Generate,
  generateLayer,
  type GenerateOptions,
  type GenerateService,
} from "./generate/generate.ts";
import { Decide, decideLayer, type DecideService } from "./decide/decide.ts";
import {
  MindModels,
  ModelCatalog,
  modelsLayer,
  type ModelCatalogService,
} from "./providers/models.ts";
import { startMcp, type McpOptions, type McpRuntime } from "./mcp/index.ts";
import type { SecretRequestsService } from "./secrets/index.ts";

export interface MindDescription {
  readonly entity: string;
  /** The decide faculty is configured (TYPESAFE_API_KEY present). */
  readonly decide: boolean;
  readonly tools: readonly string[];
}

export interface MindService {
  /** Durable conversations — chat is one form of the entity, not its whole. */
  readonly converse: ConverseService;
  /** Typed decisions through Jev — usable with zero chat. */
  readonly decide: DecideService;
  /** The mind's tool surface. */
  readonly act: ReturnType<typeof actService>;
  /** The user-approval surface behind gated acts. */
  readonly approvals: ApprovalsService;
  /** One-shot app-facing completion (titles, extraction) — no conversation. */
  readonly generate: GenerateService;
  /** The model catalog: configured providers' models from models.dev, cached. */
  readonly models: ModelCatalogService;
  /** Background sub-agent tasks in their own durable conversations. */
  readonly tasks: TasksService;
  /** User-defined entities above sessions: registry, Bot Mode, DM threads. */
  readonly profiles: ProfilesService;
  /** Contextual rooms between bots — one conversation per participant. */
  readonly rooms: RoomsService;
  /** Inter-entity messaging on per-pair DM threads. */
  readonly mailbox: MailboxService;
  /** Skills: built-in and self-written procedures, per profile, evolvable. */
  readonly skills: SkillsService;
  /** The memory seam: profile and owner stores with write authority. */
  readonly memory: MemoryService;
  /** Rereading the entity's own past: search over durable transcripts. */
  readonly history: HistoryService;
  /** Self-set schedules: cron and one-shot wake-ups the entity owns. */
  readonly schedules: SchedulesService;
  /** Routine fire receipts — the durable ledger that a trigger FIRED. */
  readonly receipts: ReceiptsService;
  /** Self-set inbound webhooks with schema validation and reject accounting. */
  readonly webhooks: WebhooksService;
  /** Durable profile-scoped key-value state — the entity's dedup ledgers live here. */
  readonly state: KvService;
  /** Watches on external sources (calendar) that wake the entity. */
  readonly sensors: SensorsService;
  /** The credential vault, when VAULT_KEY is configured; else null. */
  readonly vault: VaultStore | null;
  /** Credential-broker bindings (null without a vault). */
  readonly bindings: BindingStore | null;
  /** The append-only trail of the mind's acts. */
  readonly audit: AuditService;
  /** MCP connectors: owner-owned servers, added and removed live. */
  readonly mcp: McpManager;
  /** Secure inputs: browser-typed keys go to the vault, never the model. */
  readonly secrets: SecretRequestsService;
  readonly describe: () => MindDescription;
}

export class Mind extends Context.Service<Mind, MindService>()("spreissen/mind/Mind") {}

export interface MindOptions {
  /** Durable storage override; default is SQLite at HARNESS_DB (tests pass MemoryStorage). */
  readonly storage?: Storage;
  /** Extra extension plugins beyond the mind's own. */
  readonly plugins?: readonly Plugin[];
  /** Options for the generate faculty (token cap). */
  readonly generate?: GenerateOptions;
  /** Options for the vault (directory override). */
  readonly vault?: { readonly dir?: string };
  /** Mailbox wiring; `grantArtifacts` materializes envelope artifact grants. */
  readonly mailbox?: {
    readonly grantArtifacts?: (
      owner: string,
      from: string,
      to: string,
      ids: readonly string[],
    ) => Promise<void>;
  };
  /** Schedule-registry wiring: `onChanged` re-arms the server's cron scheduler. */
  readonly schedules?: { readonly onChanged?: () => Promise<void> };
  /** MCP connector options (config dir, timeouts, boot). */
  readonly mcp?: McpOptions;
}

/** Everything that can fail while booting the mind. */
export type MindError = External | ConfigError | Unavailable | Duplicate;

/** Wiring built in `mindLayer` that the entity composition consumes. */
interface MindWiring {
  readonly holder: ScopeHolder;
  readonly vaultStore: VaultStore | null;
  readonly vaultRoot: string | null;
  readonly bindings: BindingStore | null;
  readonly mcp?: McpOptions;
  /** Materializes mailbox envelope artifact grants (server copies files). */
  readonly grantArtifacts?: (
    owner: string,
    from: string,
    to: string,
    ids: readonly string[],
  ) => Promise<void>;
  /** Re-arms the server's cron scheduler after a schedule-registry change. */
  readonly onSchedulesChanged?: () => Promise<void>;
}

const mindLayerRaw = (
  wiring: MindWiring,
): Layer.Layer<
  Mind,
  never,
  | Decide
  | Approvals
  | MindModels
  | ModelCatalog
  | Registry
  | Converse
  | Generate
  | Tasks
  | Audit
  | PiRegistry
> =>
  Layer.effect(
    Mind,
    Effect.gen(function* () {
      const converse = yield* Converse;
      const decide = yield* Decide;
      const approvals = yield* Approvals;
      const registry = yield* Registry;
      const generate = yield* Generate;
      const tasks = yield* Tasks;
      const audit = yield* Audit;
      const models = yield* ModelCatalog;
      const act = actService(
        registry,
        approvals,
        audit,
        (conversationId) => profilesRef?.profileOf(conversationId)?.id ?? null,
        {
          // The background-work nudge fires only when a spawn is actually
          // possible: not from inside a task, and under the running cap.
          maySpawn: async (conversationId) => {
            if (profilesRef === undefined) return false;
            if (await Effect.runPromise(tasks.isTaskConversation(conversationId))) return false;
            const visible = tasksVisibleTo(
              profilesRef,
              conversationId,
              await Effect.runPromise(tasks.list()),
            );
            return visible.filter((task) => task.status === "running").length < MAX_RUNNING_TASKS;
          },
        },
      );
      // One runtime, one entity per profile: the profiles service owns the
      // session registry and the conversation→profile index; its identity
      // section (persona + roster, or the substrate baseline) reaches every
      // conversation through a late registry install.
      let mcpRef: McpRuntime | undefined;
      let botTools: readonly ToolRegistration[] = [];
      const profiles = profilesService({
        converse,
        generate,
        tools: () => [
          ...(act.extension().tools ?? []),
          ...botTools,
          ...(mcpRef?.wiring.allowlistTools() ?? []),
        ],
        implied: (allowlist) => mcpRef?.wiring.implied(allowlist) ?? [],
        // An empty catalog (models.dev unreachable on a first boot) cannot
        // judge: the ref is kept and works once the catalog lands.
        knownModel: (ref) => models.list().length === 0 || models.find(ref) !== undefined,
      });
      const profilesRef: ProfilesService = profiles;
      botTools = [
        ...botsTools({ profiles, audit, activity: taskActivity(tasks) }),
        ...botCreateTools({ profiles, approvals, audit }),
      ];
      const rooms = roomsService({ converse });
      const skills = skillsService();
      const skillsRef: SkillsService = skills;
      const mailbox = mailboxService({
        converse,
        profiles,
        rooms,
        audit,
        ...(wiring.grantArtifacts !== undefined ? { grantArtifacts: wiring.grantArtifacts } : {}),
      });
      // Messages a crash interrupted are redelivered (idempotently) on boot.
      void mailbox.recover().catch((cause) => console.error("mailbox recovery failed:", cause));
      // Tasks run as their bot: bind (and resume) only once the index exists.
      void tasks.attach(profiles.bindTask);
      const routines = routineServices(converse, profiles, wiring.onSchedulesChanged, {
        generate,
        decide,
        audit,
        untrustedTool: (name) =>
          mcpRef?.wiring.allowlistTools().some((tool) => tool.name === name) ?? false,
      });
      wirePolicies(wiring.holder, approvals, audit, profiles, decide, converse, generate);
      // Everything rides one pi-durable registry; late installs are legal —
      // the harness reconsiders its tools as the registry changes.
      const piRegistry = yield* PiRegistry;
      installFaculties(piRegistry, {
        converse,
        act,
        tasks,
        profiles,
        rooms,
        mailbox,
        botTools,
        audit,
        approvals,
        skills: skillsRef,
        untrustedTool: (name) =>
          mcpRef?.wiring.allowlistTools().some((tool) => tool.name === name) ?? false,
        ...routines,
      });
      // Connectors install after everything else so their names never shadow ours.
      const mcp = startMcp(
        piRegistry,
        { approvals, audit, profiles },
        { store: wiring.vaultStore, root: wiring.vaultRoot, bindings: wiring.bindings },
        wiring.mcp,
      );
      mcpRef = mcp;
      yield* Effect.addFinalizer(() => Effect.promise(mcp.close));
      return {
        converse,
        decide,
        act,
        approvals,
        generate,
        models,
        tasks,
        profiles,
        rooms,
        mailbox,
        skills,
        ...routines,
        mcp: mcp.manager,
        secrets: mcp.secrets,
        vault: wiring.vaultStore,
        bindings: wiring.bindings,
        audit,
        describe: () => describeMind(act, decide, piRegistry),
      };
    }),
  );

/**
 * The whole mind from options. Wiring: decide -> registry (the decision
 * plugin rides the registry); models + registry + approvals + audit +
 * pi-registry -> converse; converse -> tasks; models -> generate; all
 * services -> the entity.
 */
export const mindLayer = (options: MindOptions): Layer.Layer<Mind, MindError> => {
  const models = modelsLayer;
  const decide = decideLayer;
  const approvals = approvalsLayer;
  const audit = auditLayer;
  const piRegistry = piRegistryLayer;
  const generate = generateLayer(options.generate).pipe(Layer.provide(models));
  // The scope holder is created before the registry so ext plugins (artifacts
  // dirs, vault lists) can partition per profile; the entity sets it once the
  // conversation→profile index exists. Same lifecycle for the vault store.
  const holder = createScopeHolder();
  const vaultRoot = vaultConfigured() ? (options.vault?.dir ?? vaultDir()) : null;
  const vaultStore = vaultRoot !== null ? makeVaultStore(vaultRoot) : null;
  const bindings = vaultRoot !== null ? makeBindingStore(vaultRoot) : null;
  const wiring: MindWiring = {
    holder,
    vaultStore,
    vaultRoot,
    bindings,
    ...(options.mcp !== undefined ? { mcp: options.mcp } : {}),
    ...(options.mailbox?.grantArtifacts !== undefined
      ? { grantArtifacts: options.mailbox.grantArtifacts }
      : {}),
    ...(options.schedules?.onChanged !== undefined
      ? { onSchedulesChanged: options.schedules.onChanged }
      : {}),
  };
  const registry = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const decideService = yield* Decide;
      // http_request rides always (credential-less calls need no vault).
      const broker = yield* brokerFor(vaultStore, bindings, holder);
      // First-party faculties ride always (temporal, artifacts); the vault and
      // TinyFish live-web egress and Jev install only when keys are present.
      const base = [
        temporalPlugin(),
        artifactsPlugin({ holder }),
        bashPlugin({ holder }),
        ...(calendarConfigured() ? [calendarPlugin()] : []),
        ...(emailConfigured() ? [emailPlugin()] : []),
        ...(vaultStore !== null ? [vaultPlugin(vaultStore, holder)] : []),
        ...(tinyfishConfigured() ? [tinyfishPlugin] : []),
        broker,
      ];
      const plugins = decideService.available
        ? [...base, decisionPlugin(decideService), ...(options.plugins ?? [])]
        : [...base, ...(options.plugins ?? [])];
      return yield* makeRegistry(plugins);
    }),
  ).pipe(Layer.provide(decideLayer.pipe(Layer.merge(approvals)).pipe(Layer.merge(audit))));
  const converse = converseLayer(options.storage).pipe(
    Layer.provide(
      models
        .pipe(Layer.merge(registry))
        .pipe(Layer.merge(approvals))
        .pipe(Layer.merge(audit))
        .pipe(Layer.merge(piRegistry)),
    ),
  );
  const tasks = tasksLayer.pipe(Layer.provide(converse));
  const dependencies = converse
    .pipe(Layer.merge(decide))
    .pipe(Layer.merge(approvals))
    .pipe(Layer.merge(models))
    .pipe(Layer.merge(registry))
    .pipe(Layer.merge(audit))
    .pipe(Layer.merge(piRegistry))
    .pipe(Layer.merge(generate))
    .pipe(Layer.merge(tasks));
  return mindLayerRaw(wiring).pipe(Layer.provide(dependencies));
};

export interface MindHandle {
  readonly mind: MindService;
  /** Runs the mind's finalizers (durable harness). */
  readonly close: () => Promise<void>;
}

/** The promise-land door: open a live mind. The server and the probe enter here. */
export const openMind = (options: MindOptions = {}): Promise<MindHandle> =>
  openRuntime(mindLayer(options), Mind).then((runtime: Runtime<MindService>) => ({
    mind: runtime.service,
    close: runtime.close,
  }));

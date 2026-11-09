/**
 * The mind — the entity substrate (`@spriessen/mind` keeps its working package
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
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { openRuntime, type Runtime } from "@spriessen/core";
import { nodeShellFacadeOf } from "./nodes/facade.ts";
import {
  artifactsDir,
  artifactsPlugin,
  bashPlugin,
  browserPlugin,
  codeIntelPlugin,
  filesPlugin,
  graphPlugin,
  calendarConfigured,
  calendarPlugin,
  createScopeHolder,
  emailConfigured,
  emailPlugin,
  browserSessionFacility,
  JobKiller,
  makeRegistry,
  Registry,
  tinyfishConfigured,
  tinyfishPlugin,
  vaultConfigured,
  vaultDir,
  makeVaultStore,
  vaultPlugin,
  makeBindingStore,
} from "@spriessen/ext";
import { Approvals, approvalsLayer } from "./approvals.ts";
import { actService } from "./act/act.ts";
import { decisionPlugin } from "./act/decision-tools.ts";
import { brokerFor } from "./act/broker.ts";
import { describeMind, installFaculties, routineServices, wirePolicies } from "./entity-parts.ts";
import { openSearchDb } from "./search/db.ts";
import { embedderFromEnv, MEANING_OFF, trackedEmbedder } from "./search/embedders.ts";
import { temporalPlugin } from "./act/temporal.ts";
import { Audit, auditLayer } from "./audit/audit.ts";
import { Converse, converseLayer, type ConverseService } from "./converse/converse.ts";
import { PiRegistry, piRegistryLayer } from "./converse/pi-registry.ts";
import { deadlinesExtension, limitsOf, turnDeadlines } from "./converse/deadlines.ts";
import { Tasks, tasksLayer } from "./tasks/tasks.ts";
import { taskWiring } from "./tasks/wiring.ts";
import { healChats } from "./entity-chats.ts";
import { profilesService, type ProfilesService } from "./profiles/profiles.ts";
import { botFiles } from "./profiles/bot-files.ts";
import { readProfiles } from "./profiles/docs.ts";
import { botsTools, taskActivity } from "./profiles/bots-tools.ts";
import { checklistTools } from "./checklist/tools.ts";
import { adminTools } from "./admin/index.ts";
import { questionTools } from "./ask/question.ts";
import { roomsService } from "./profiles/rooms.ts";
import { mailboxService } from "./mailbox/mailbox.ts";
import { usageService, usageSinkOf } from "./usage/usage.ts";
import { tablesService } from "./tables/tables.ts";
import { teamInstructionsOf, teamOfProfile, orgService } from "./org/service.ts";
import {
  defaultDeleteTeamStore,
  defaultDestroyHomeVm,
  defaultReconcileTeamGroups,
  defaultRetireBotUser,
} from "./org/home-scope.ts";
import type { MindError, MindOptions, MindWiring } from "./entity-options.ts";
import { auditedMailbox } from "./org/reach.ts";
import { skillsService, type SkillsService } from "./skills/service.ts";
import { Generate, generateLayer } from "./generate/generate.ts";
import { Decide, decideLayer } from "./decide/decide.ts";
import { MindModels, ModelCatalog, modelsLayer } from "./providers/models.ts";
import { wireLateFaculties } from "./entity-late.ts";
import { bashJobHost } from "./act/bash-jobs.ts";
import { MCP_EXTENSION, startMcp, mcpOptionsWithHostSwitch, type McpRuntime } from "./mcp/index.ts";
import { hostExcludedTools, mindHostSwitchWatch, type HostSwitchWatch } from "./org/host-switch.ts";
import type { MindService } from "./entity-api.ts";
import { dataPath } from "@spriessen/core";
export type { MindDescription, MindService } from "./entity-api.ts";

export class Mind extends Context.Service<Mind, MindService>()("spriessen/mind/Mind") {}

export type { MindError, MindOptions } from "./entity-options.ts";

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
      wiring.converseRef.current = converse;
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
        wiring.hostAccess,
      );
      // One runtime, one entity per profile: the profiles service owns the
      // session registry and the conversation→profile index; its identity
      // section (persona + roster, or the substrate baseline) reaches every
      // conversation through a late registry install.
      let mcpRef: McpRuntime | undefined;
      let botTools: readonly ToolRegistration[] = [];
      const files = botFiles();
      // One VM per home: the sweep that retires a removed or MOVED bot's
      // Linux user from its (old) home's VM — best effort, never failing the
      // removal. The org VM is destroyed only with the org; a bot purge
      // destroys no VM at all.
      const destroyHomeVm = wiring.destroyHomeVm ?? defaultDestroyHomeVm();
      const retireBotUser = wiring.retireBotUser ?? defaultRetireBotUser(converse);
      const reconcileTeamGroups = wiring.reconcileTeamGroups ?? defaultReconcileTeamGroups();
      const deleteTeamStore = wiring.deleteTeamStore ?? defaultDeleteTeamStore();
      // Slice 10: the switch watch — snapshot for the list exclusion, re-applies on a flip.
      const hostSwitch: { current: HostSwitchWatch | undefined } = { current: undefined };
      const piRegistryEarly = yield* PiRegistry;
      const profiles = profilesService({
        converse,
        generate,
        files,
        retireUserFromHome: retireBotUser,
        tools: () => [
          ...(act.extension().tools ?? []),
          ...botTools,
          ...(mcpRef?.wiring.allowlistTools() ?? []),
        ],
        // Connector tools are allowlist-governed only through the catalog:
        // never let a registry-only connector tool slip past an allowlist.
        allTools: () =>
          piRegistryEarly
            .snapshot()
            .tools()
            .filter(({ extension }) => !extension.name.startsWith(MCP_EXTENSION))
            .map(({ tool }) => tool),
        implied: (allowlist) => mcpRef?.wiring.implied(allowlist) ?? [],
        hostExcluded: (profile) =>
          hostExcludedTools(
            hostSwitch.current?.flags(),
            profile,
            mcpRef?.wiring.hostDirectToolNames() ?? [],
          ),
        // An empty catalog (models.dev unreachable on a first boot) cannot
        // judge: the ref is kept and works once the catalog lands.
        knownModel: (ref) => models.list().length === 0 || models.find(ref) !== undefined,
      });
      const profilesRef: ProfilesService = profiles;
      const org = orgService(converse, {
        destroyHomeVm,
        retireBotUser,
        reconcileTeamGroups,
        deleteTeamStore,
        // Slice 10: a flip re-applies every bot's agent (its tool list changed).
        onChanged: () => hostSwitch.current?.onOrgChange(),
      });
      // Persona and Instructions files: every existing bot gets both, once.
      void Effect.runPromise(readProfiles(converse))
        .then((rows) => files.migrate(rows))
        .catch((cause) => console.error("bot files migration failed:", cause));
      botTools = [
        ...botsTools({ profiles, audit, activity: taskActivity(tasks) }),
        ...adminTools({
          profiles,
          approvals,
          audit,
          converse,
          org,
          ...(wiring.admin !== undefined ? { admin: wiring.admin } : {}),
        }),
        ...questionTools({ profiles, approvals, audit }),
        ...checklistTools({ converse, profiles, audit }),
      ];
      const rooms = roomsService({ converse });
      const skills = skillsService();
      const skillsRef: SkillsService = skills;
      const mailbox = auditedMailbox(
        mailboxService({
          converse,
          profiles,
          rooms,
          audit,
          judge: decide,
          ...(wiring.grantArtifacts !== undefined ? { grantArtifacts: wiring.grantArtifacts } : {}),
        }),
        { converse, audit },
      );
      // Messages a crash interrupted are redelivered (idempotently) on boot.
      void mailbox.recover().catch((cause) => console.error("mailbox recovery failed:", cause));
      // The daily spend ledger: every settled turn's tokens land here, and a
      // bot's dailyTokenBudget gates its task admission (queue.ts).
      const usage = usageService(converse);
      if (wiring.usageRef !== undefined) {
        wiring.usageRef.current = usageSinkOf({
          converse,
          usage,
          scopeOf: (conversationId) => profiles.scopeOf(conversationId),
        });
      }
      // Tasks run as their bot: bind (and resume) only once the index exists.
      void tasks.attach(
        profiles.bindTask,
        taskWiring(profiles, wiring.holder, {
          cancelMailSentFrom: (conversations) => mailbox.cancelSentFrom(conversations),
          // A finished task's browser session closes (sign-ins saved) instead of idling.
          ...(wiring.browserLife !== undefined
            ? { onSettled: (conversationId: string) => wiring.browserLife?.release(conversationId) }
            : {}),
          ...(wiring.jobKiller !== undefined
            ? {
                stopJobsOf: async (conversations: readonly string[]) =>
                  wiring.jobKiller?.(conversations) ?? 0,
              }
            : {}),
          spendOf: async (bot) => {
            if (bot === null) return { today: 0, budget: null };
            const profile = await profiles.get(bot.owner, bot.profileId).catch(() => undefined);
            return {
              today: await usage.today(bot.owner, bot.profileId),
              budget: profile?.policies.dailyTokenBudget ?? null,
            };
          },
          fallbackModel: async () => {
            const stored = await profiles.workspaceFallbackModel().catch(() => null);
            if (stored === null) return null;
            return models.find(stored.ref) !== undefined
              ? { id: stored.ref, effort: stored.effort }
              : null;
          },
        }),
      );
      // The search sidecar: derived, rebuildable, closed with the mind.
      const searchDb = yield* Effect.acquireRelease(
        Effect.sync(() => openSearchDb(wiring.searchDbPath)),
        (db) => Effect.sync(() => db.close()),
      );
      // The meaning leg is opt-in (MEMORY_EMBEDDINGS=ollama): a local model.
      const configured = embedderFromEnv(
        (name) => process.env[name],
        (providerId) => models.embeddingEndpointOf(providerId),
      );
      const meaning = configured === undefined ? undefined : trackedEmbedder(configured);
      const embedder = meaning?.embedder;
      const routines = routineServices(converse, profiles, wiring.onSchedulesChanged, {
        generate,
        decide,
        audit,
        searchDb,
        ...(embedder !== undefined ? { embedder } : {}),
        untrustedTool: (name) =>
          mcpRef?.wiring.allowlistTools().some((tool) => tool.name === name) ?? false,
      });
      wirePolicies(
        wiring.holder,
        approvals,
        audit,
        profiles,
        decide,
        converse,
        generate,
        artifactsDir(),
      );
      // Everything rides one pi-durable registry; late installs are legal —
      // the harness reconsiders its tools as the registry changes.
      const piRegistry = yield* PiRegistry;
      const tables = tablesService(converse);
      installFaculties(piRegistry, {
        converse,
        act,
        tasks,
        profiles,
        rooms,
        mailbox,
        tables,
        botTools,
        audit,
        approvals,
        skills: skillsRef,
        teamInstructions: teamInstructionsOf(converse),
        teamOf: teamOfProfile(converse),
        knownModel: (ref) => models.list().length === 0 || models.find(ref) !== undefined,
        untrustedTool: (name) =>
          mcpRef?.wiring.allowlistTools().some((tool) => tool.name === name) ?? false,
        ...routines,
      });
      // Turn deadlines (D4, per bot): every model request starts the watch.
      const deadlines = turnDeadlines({
        converse,
        limitsFor: (conversationId) => limitsOf(profiles.profileOf(conversationId)?.policies),
        paused: (conversationId) => approvals.pendingFor(conversationId).length > 0,
        onHit: (conversationId, hit) =>
          console.warn(`turn deadline (${hit.kind}) stopped conversation ${conversationId}`),
      });
      piRegistry.install(deadlinesExtension(deadlines));
      yield* Effect.addFinalizer(() => Effect.sync(deadlines.stop));
      // Connectors install after everything else so their names never shadow ours.
      // Slice 10: the stdio connectors ride the same switch (per-call gate + section).
      const mcpHost =
        wiring.hostAccess === undefined
          ? undefined
          : { hostAccess: wiring.hostAccess, watch: () => hostSwitch.current };
      const mcp = startMcp(
        piRegistry,
        { approvals, audit, profiles },
        { store: wiring.vaultStore, root: wiring.vaultRoot, bindings: wiring.bindings },
        mcpOptionsWithHostSwitch(wiring.mcp, mcpHost),
      );
      mcpRef = mcp;
      // Slice 10: the watch is live at boot; the awaited read removes the race.
      hostSwitch.current = mindHostSwitchWatch({ org, profiles, converse, tasks });
      yield* Effect.promise(() => hostSwitch.current?.refresh() ?? Promise.resolve());
      // Heal conversations whose stored tool list predates the current rules
      // (a fixed list once dropped `message` for every host-switch-off bot).
      yield* Effect.promise(() => hostSwitch.current?.resyncStored() ?? Promise.resolve());
      yield* Effect.addFinalizer(() => Effect.promise(mcp.close));
      // Turns a restart cut off continue now, with every tool installed
      // (connector tools join as their servers connect). One cut off too many
      // times in a row is parked instead and shows in Needs you.
      const { projects, evals, trials } = yield* Effect.promise(() =>
        wireLateFaculties(piRegistry, { converse, profiles, decide, models, audit, tasks }),
      );
      // Chats coordinate, tasks work: chats made before the split get the
      // chat-only tool filter before any of their turns resumes.
      yield* Effect.promise(() => healChats(converse, profiles));
      converse.resume();
      return {
        evals,
        trials,
        projects,
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
        usage,
        tables,
        ...(wiring.browserTakeovers !== undefined
          ? { browserTakeovers: wiring.browserTakeovers }
          : {}),
        ...(wiring.browserCasts !== undefined ? { browserCasts: wiring.browserCasts } : {}),
        ...(wiring.browserSessions !== undefined
          ? { browserSessions: wiring.browserSessions }
          : {}),
        ...(wiring.browserLife !== undefined ? { browserLife: wiring.browserLife } : {}),
        ...(wiring.browserSignins !== undefined ? { browserSignins: wiring.browserSignins } : {}),
        org,
        ...routines,
        mcp: mcp.manager,
        secrets: mcp.secrets,
        vault: wiring.vaultStore,
        bindings: wiring.bindings,
        audit,
        describe: () => describeMind(act, decide, piRegistry),
        meaning: () => meaning?.status() ?? MEANING_OFF,
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
  const converseRef: { current?: ConverseService } = {};
  const vaultRoot = vaultConfigured() ? (options.vault?.dir ?? vaultDir()) : null;
  const vaultStore = vaultRoot !== null ? makeVaultStore(vaultRoot) : null;
  const bindings = vaultRoot !== null ? makeBindingStore(vaultRoot) : null;
  // One kill switch for background bash jobs: the bash plugin tracks each
  // job's abort signal on it; work-tree stops (tasks/tree.ts) reach it
  // through the task wiring.
  const jobKiller = new JobKiller();
  // Browser takeovers: the session plugin's registry, driven by the owner's
  // REST. The asking tool call itself waits (a blocking takeover), so there
  // is no wake to route — the turn that asked gets the page as its result.
  const browserSession = browserSessionFacility({ holder });
  const wiring: MindWiring = {
    jobKiller: (conversations) => jobKiller.killConversations(conversations),
    holder,
    searchDbPath: searchDbPathOf(options),
    vaultStore,
    vaultRoot,
    bindings,
    converseRef,
    usageRef: {},
    browserTakeovers: browserSession.takeovers,
    browserCasts: browserSession.casts,
    browserSessions: browserSession.browsers,
    browserLife: browserSession.life,
    ...(browserSession.signins !== undefined ? { browserSignins: browserSession.signins } : {}),
    ...(options.mcp !== undefined ? { mcp: options.mcp } : {}),
    ...(options.mailbox?.grantArtifacts !== undefined
      ? { grantArtifacts: options.mailbox.grantArtifacts }
      : {}),
    ...(options.schedules?.onChanged !== undefined
      ? { onSchedulesChanged: options.schedules.onChanged }
      : {}),
    ...(options.destroyHomeVm !== undefined ? { destroyHomeVm: options.destroyHomeVm } : {}),
    ...(options.retireBotUser !== undefined ? { retireBotUser: options.retireBotUser } : {}),
    ...(options.reconcileTeamGroups !== undefined
      ? { reconcileTeamGroups: options.reconcileTeamGroups }
      : {}),
    ...(options.deleteTeamStore !== undefined ? { deleteTeamStore: options.deleteTeamStore } : {}),
    ...(options.nodeExec !== undefined ? { nodeExec: options.nodeExec } : {}),
    ...(options.authz !== undefined ? { admin: options.authz } : {}),
    ...(options.authz?.hostAccess !== undefined
      ? {
          hostAccess: async (conversationId: string): Promise<boolean> => {
            const scope = holder.get()?.scopeOf(conversationId);
            return (
              (await options.authz?.hostAccess?.({
                owner: scope?.owner ?? "",
                profileId: scope?.profile ?? null,
              })) ?? true
            );
          },
        }
      : {}),
  };
  const registry = Layer.effect(
    Registry,
    Effect.gen(function* () {
      const decideService = yield* Decide;
      // http_request rides always (credential-less calls need no vault).
      const broker = yield* brokerFor(
        vaultStore,
        bindings,
        holder,
        () => wiring.converseRef.current,
      );
      // First-party faculties ride always; vault, TinyFish and Jev only with their keys.
      const base = [
        temporalPlugin(),
        artifactsPlugin({ holder }),
        bashPlugin({
          holder,
          jobs: bashJobHost(() => wiring.converseRef.current),
          jobKiller,
          ...(wiring.nodeExec !== undefined
            ? { nodes: nodeShellFacadeOf(wiring.converseRef, wiring.nodeExec) }
            : {}),
        }),
        browserPlugin({ holder }),
        browserSession.plugin,
        filesPlugin({ holder }),
        codeIntelPlugin({ holder }),
        graphPlugin(),
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
  const converse = converseLayer(options.storage, wiring.usageRef ?? {}).pipe(
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

/**
 * Where the search sidecar lives: `SEARCH_DB` when set; in memory when the
 * mind runs on injected storage (tests, smoke) so nothing touches disk;
 * else beside the harness database.
 */
const searchDbPathOf = (options: MindOptions): string => {
  const configured = process.env.SEARCH_DB?.trim();
  if (configured !== undefined && configured !== "") return configured;
  return options.storage !== undefined ? ":memory:" : dataPath("search.sqlite");
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

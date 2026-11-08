/**
 * The mind's surface: MindService, the faculties every host (server, probe,
 * tests) reaches through openMind, and MindDescription. entity.ts composes
 * it.
 */

import type { EvalsService } from "./evals/evals.ts";
import type { TrialsService } from "./routines/trial.ts";
import type { ProjectsService } from "./projects/service.ts";
import type { BindingStore, McpManager, VaultStore } from "@spriessen/ext";
import type { ApprovalsService } from "./approvals.ts";
import { actService } from "./act/act.ts";
import type { AuditService } from "./audit/audit.ts";
import type { ConverseService } from "./converse/converse.ts";
import type { TasksService } from "./tasks/tasks.ts";
import type { ProfilesService } from "./profiles/profiles.ts";
import type { RoomsService } from "./profiles/rooms.ts";
import type { MailboxService } from "./mailbox/mailbox.ts";
import type { UsageService } from "./usage/usage.ts";
import type { TablesService } from "./tables/tables.ts";
import type { TakeoverRegistry } from "@spriessen/ext";
import type { OrgService } from "./org/service.ts";
import type { SkillsService } from "./skills/service.ts";
import type { MemoryService } from "./memory/memory.ts";
import type { HistoryService } from "./history/history.ts";
import type { MeaningStatus } from "./search/embedders.ts";
import type { SchedulesService } from "./schedules/schedules.ts";
import type { ReceiptsService } from "./routines/receipts.ts";
import type { WebhooksService } from "./webhooks/webhooks.ts";
import type { KvService } from "./state/kv.ts";
import type { SensorsService } from "./sensors/sensors.ts";
import type { GenerateService } from "./generate/generate.ts";
import type { DecideService } from "./decide/decide.ts";
import type { ModelCatalogService } from "./providers/models.ts";
import type { SecretRequestsService } from "./secrets/index.ts";

export interface MindDescription {
  readonly entity: string;
  /** The decide faculty is configured (TYPESAFE_API_KEY present). */
  readonly decide: boolean;
  readonly tools: readonly string[];
  /** The same catalog with each tool's one-line description (allowlist editor). */
  readonly catalog: readonly { readonly name: string; readonly description: string }[];
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
  /** The daily spend ledger (usage/usage.ts): tokens per profile per day. */
  readonly usage: UsageService;
  /** The profile's typed tables (tables/tables.ts). */
  readonly tables: TablesService;
  /** The browser-takeover registry (absent when the browser session is not wired). */
  readonly browserTakeovers?: TakeoverRegistry;
  /** The org: one per install, flat teams, members, grants, templates. */
  readonly org: OrgService;
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
  /** Behaviour tests: chat messages saved as cases, replayed and graded. */
  readonly evals: EvalsService;
  /** Routine trials: a schedule run with every tool held back (routines/trial.ts). */
  readonly trials: TrialsService;
  /** Goals a bot works toward over days: milestones, a log, a status. */
  readonly projects: ProjectsService;
  readonly describe: () => MindDescription;
  /** The memory meaning leg: which embedding model, local or remote, last result. */
  readonly meaning: () => MeaningStatus;
}

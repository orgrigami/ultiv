import { Type, type Static } from "typebox";
import { ModelInfoSchema } from "./session.ts";

export const SessionKindSchema = Type.Union([
  Type.Literal("main"),
  Type.Literal("session"),
  Type.Literal("dm"),
  Type.Literal("room"),
  /** A background task conversation — inherits its spawner's bot scope. */
  Type.Literal("task"),
]);

export type SessionKind = Static<typeof SessionKindSchema>;

export const SessionInfoSchema = Type.Object({
  id: Type.String(),
  /** Registry owner the session belongs to (header-scoped; "guest" unauthenticated). */
  owner: Type.String(),
  /** The profile (entity workspace) this session lives under. */
  profile: Type.String(),
  /** `main` = the profile's persistent chat; `dm` = one thread per entity pair. */
  kind: SessionKindSchema,
  /** For DM threads: the two participating profile ids; else null. */
  participants: Type.Union([Type.Array(Type.String()), Type.Null()]),
  title: Type.String(),
  createdAt: Type.Number(),
  lastMessageAt: Type.Number(),
});

export type SessionInfo = Static<typeof SessionInfoSchema>;

export const SessionListSchema = Type.Array(SessionInfoSchema);

export type SessionList = Static<typeof SessionListSchema>;

export const ModelListSchema = Type.Array(ModelInfoSchema);

export type Models = Static<typeof ModelListSchema>;

/** The workspace default model and where it is set (`GET /api/settings/model`). */
export const WorkspaceDefaultModelSchema = Type.Object({
  ref: Type.String(),
  /** Thinking effort; "" = the model's default. */
  effort: Type.String(),
  /** "db" = the stored setting; "env" = the SPRIESSEN_MODEL environment. */
  source: Type.Union([Type.Literal("db"), Type.Literal("env")]),
});

export type WorkspaceDefaultModel = Static<typeof WorkspaceDefaultModelSchema>;

/** `GET /api/settings/model`; null = no default exists (db and env unset). */
export const SettingsModelSchema = Type.Object({
  defaultModel: Type.Union([WorkspaceDefaultModelSchema, Type.Null()]),
});

export type SettingsModel = Static<typeof SettingsModelSchema>;

/** `GET /api/models`: the picker list plus the effective workspace default. */
export const ModelsPayloadSchema = Type.Object({
  models: ModelListSchema,
  workspaceDefault: Type.Union([WorkspaceDefaultModelSchema, Type.Null()]),
});

export type ModelsPayload = Static<typeof ModelsPayloadSchema>;

/** The model catalog's state (`GET /api/models/catalog`, `POST /api/models/refresh`). */
export const ModelCatalogStatusSchema = Type.Object({
  source: Type.Union([Type.Literal("network"), Type.Literal("cache"), Type.Literal("none")]),
  fetchedAt: Type.Union([Type.Number(), Type.Null()]),
  providers: Type.Array(Type.String()),
  models: Type.Number(),
  error: Type.Union([Type.String(), Type.Null()]),
  /** The kenari live listing (the gateway runs ahead of models.dev). */
  kenari: Type.Optional(
    Type.Object({
      source: Type.Union([Type.Literal("network"), Type.Literal("cache"), Type.Literal("none")]),
      fetchedAt: Type.Union([Type.Number(), Type.Null()]),
      models: Type.Number(),
    }),
  ),
  /** The model new conversations start on (`provider/model`). */
  default: Type.String(),
});

export type ModelCatalogStatus = Static<typeof ModelCatalogStatusSchema>;

/**
 * The session registry is served as plain REST (`/api/sessions`, `/api/models`
 * on the server's HTTP handler), not as a chord object: it is CRUD, not
 * replicated state, and chord 1.4.0's wire replication desyncs on attach.
 * These schemas are the REST payload shapes.
 */

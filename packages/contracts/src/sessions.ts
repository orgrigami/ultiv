import {
  arr,
  lit,
  nul,
  num,
  obj,
  oneOf,
  opt,
  str,
  union,
  type Static,
} from "@earendil-works/pi-schema";
import { ModelInfoSchema } from "./session.ts";

export const SessionKindSchema = union([
  lit("main"),
  lit("session"),
  lit("dm"),
  lit("room"),
  /** A background task conversation — inherits its spawner's bot scope. */
  lit("task"),
]);

export type SessionKind = Static<typeof SessionKindSchema>;

export const SessionInfoSchema = obj(
  {
    id: str(),
    /** Registry owner the session belongs to (header-scoped; "guest" unauthenticated). */
    owner: str(),
    /** The profile (entity workspace) this session lives under. */
    profile: str(),
    /** `main` = the profile's persistent chat; `dm` = one thread per entity pair. */
    kind: SessionKindSchema,
    /** For DM threads: the two participating profile ids; else null. */
    participants: union([arr(str()), nul()]),
    title: str(),
    createdAt: num(),
    lastMessageAt: num(),
    /**
     * A chat branched off another one: the source session and the transcript
     * id of the message it branched at (an edited owner message, or the bot
     * reply it continues from).
     */
    branchOf: opt(obj({ sessionId: str(), at: num() }, { open: true })),
  },
  { open: true },
);

export type SessionInfo = Static<typeof SessionInfoSchema>;

/** The longest edited message a branch accepts (POST /api/sessions/:id/branch). */
export const MAX_EDIT_CHARS = 20_000;

export const SessionListSchema = arr(SessionInfoSchema);

export type SessionList = Static<typeof SessionListSchema>;

export const ModelListSchema = arr(ModelInfoSchema);

export type Models = Static<typeof ModelListSchema>;

/** The workspace default model and where it is set (`GET /api/settings/model`). */
export const WorkspaceDefaultModelSchema = obj(
  {
    ref: str(),
    /** Thinking effort; "" = the model's default. */
    effort: str(),
    /** "db" = the stored setting; "env" = the SPRIESSEN_MODEL environment. */
    source: oneOf(["db", "env"]),
  },
  { open: true },
);

export type WorkspaceDefaultModel = Static<typeof WorkspaceDefaultModelSchema>;

/** `GET /api/settings/model`; null = no default exists (db and env unset). */
export const SettingsModelSchema = obj(
  {
    defaultModel: union([WorkspaceDefaultModelSchema, nul()]),
  },
  { open: true },
);

export type SettingsModel = Static<typeof SettingsModelSchema>;

/** `GET /api/models`: the picker list plus the effective workspace default. */
export const ModelsPayloadSchema = obj(
  {
    models: ModelListSchema,
    workspaceDefault: union([WorkspaceDefaultModelSchema, nul()]),
  },
  { open: true },
);

export type ModelsPayload = Static<typeof ModelsPayloadSchema>;

/** The model catalog's state (`GET /api/models/catalog`, `POST /api/models/refresh`). */
export const ModelCatalogStatusSchema = obj(
  {
    source: oneOf(["network", "cache", "none"]),
    fetchedAt: union([num(), nul()]),
    providers: arr(str()),
    models: num(),
    error: union([str(), nul()]),
    /** The kenari live listing (the gateway runs ahead of models.dev). */
    kenari: opt(
      obj(
        {
          source: oneOf(["network", "cache", "none"]),
          fetchedAt: union([num(), nul()]),
          models: num(),
        },
        { open: true },
      ),
    ),
    /** The model new conversations start on (`provider/model`). */
    default: str(),
  },
  { open: true },
);

export type ModelCatalogStatus = Static<typeof ModelCatalogStatusSchema>;

/**
 * The session registry is served as plain REST (`/api/sessions`, `/api/models`
 * on the server's HTTP handler), not as a chord object: it is CRUD, not
 * replicated state, and chord 1.4.0's wire replication desyncs on attach.
 * These schemas are the REST payload shapes.
 */

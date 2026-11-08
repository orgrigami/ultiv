import { arr, bool, nul, num, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";

/**
 * One artifact of the workspace: a file an agent wrote or a user uploaded,
 * stored server-side and served raw to clients. Metadata is the sidecar the
 * store keeps beside the bytes.
 */
export const ArtifactInfoSchema = obj(
  {
    id: str(),
    name: str(),
    mime: str(),
    bytes: num(),
    createdAt: num(),
    /** The durable conversation that wrote the artifact; null for REST uploads without a session. */
    conversationId: union([str(), nul()]),
    /** The owner the artifact belongs to; null on legacy sidecars (uuid-capability access). */
    owner: union([str(), nul()]),
    /** The profile workspace the artifact lives in; null on legacy sidecars. */
    profile: union([str(), nul()]),
    /** Where the file sits in its bot's tree ("reports/board.md"); absent on loose legacy files. */
    path: opt(str()),
    /** The last write; a file written again at its path keeps its id and createdAt. */
    updatedAt: opt(num()),
    /** Set on an earlier version of a file (the head's id); versions never list as files. */
    versionOf: opt(str()),
  },
  { open: true },
);

export type ArtifactInfo = Static<typeof ArtifactInfoSchema>;

export const ArtifactListSchema = arr(ArtifactInfoSchema);

export type ArtifactList = Static<typeof ArtifactListSchema>;

/**
 * The chat a file came from, resolved by the server (GET /api/artifacts
 * `?sources=1`, and every `/meta`): the session whose conversation wrote it,
 * or — for a file a background task wrote — the chat that spawned the task,
 * with the task named. Null when nothing maps (an upload, a purged chat).
 */
export const ArtifactSourceSchema = obj(
  {
    sessionId: str(),
    title: str(),
    /** The bot's main chat (opened as its Chat tab, not /c/). */
    main: bool(),
    botId: str(),
    task: opt(obj({ id: str(), title: str() }, { open: true })),
  },
  { open: true },
);

export type ArtifactSource = Static<typeof ArtifactSourceSchema>;

import { Type, type Static } from "typebox";

/**
 * One artifact of the workspace: a file an agent wrote or a user uploaded,
 * stored server-side and served raw to clients. Metadata is the sidecar the
 * store keeps beside the bytes.
 */
export const ArtifactInfoSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  mime: Type.String(),
  bytes: Type.Number(),
  createdAt: Type.Number(),
  /** The durable conversation that wrote the artifact; null for REST uploads without a session. */
  conversationId: Type.Union([Type.String(), Type.Null()]),
  /** The owner the artifact belongs to; null on legacy sidecars (uuid-capability access). */
  owner: Type.Union([Type.String(), Type.Null()]),
  /** The profile workspace the artifact lives in; null on legacy sidecars. */
  profile: Type.Union([Type.String(), Type.Null()]),
});

export type ArtifactInfo = Static<typeof ArtifactInfoSchema>;

export const ArtifactListSchema = Type.Array(ArtifactInfoSchema);

export type ArtifactList = Static<typeof ArtifactListSchema>;

/**
 * The chat a file came from, resolved by the server (GET /api/artifacts
 * `?sources=1`, and every `/meta`): the session whose conversation wrote it,
 * or — for a file a background task wrote — the chat that spawned the task,
 * with the task named. Null when nothing maps (an upload, a purged chat).
 */
export const ArtifactSourceSchema = Type.Object({
  sessionId: Type.String(),
  title: Type.String(),
  /** The bot's main chat (opened as its Chat tab, not /c/). */
  main: Type.Boolean(),
  botId: Type.String(),
  task: Type.Optional(Type.Object({ id: Type.String(), title: Type.String() })),
});

export type ArtifactSource = Static<typeof ArtifactSourceSchema>;

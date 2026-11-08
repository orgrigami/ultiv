/**
 * The Files slice of the REST client (spread into `api`): a bot's files,
 * their raw bytes, uploads, and a file's earlier versions.
 */
import type { ArtifactRow } from "./api-types.ts";
import { base, failure, getJson, send } from "./api.ts";

export const artifactsApi = {
  /** A bot's files, newest first, each with the chat it came from. */
  artifacts: (profile: string): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts?profile=${encodeURIComponent(profile)}&sources=1`),
  /** The newest files across every bot, with their chats (the Now page). */
  recentArtifacts: (limit: number): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts?limit=${limit}&sources=1`),
  artifactMeta: (id: string): Promise<ArtifactRow> =>
    getJson<ArtifactRow>(`/api/artifacts/${encodeURIComponent(id)}/meta`),
  /** A file's earlier versions, newest first (each is an artifact of its own). */
  artifactVersions: (id: string): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts/${encodeURIComponent(id)}/versions`),
  /** Put an earlier version back; what was there becomes a version itself. */
  restoreArtifactVersion: (id: string, versionId: string): Promise<ArtifactRow> =>
    send<ArtifactRow>(
      `/api/artifacts/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      "POST",
    ),
  artifactUrl: (id: string, download?: boolean): string =>
    `${base()}/api/artifacts/${encodeURIComponent(id)}${download === true ? "?dl=1" : ""}`,
  /** POST /api/artifacts with the raw bytes; the server 413s over its 10 MB cap. */
  artifactUpload: async (file: Blob, name: string, sessionId?: string): Promise<ArtifactRow> => {
    const query = new URLSearchParams({
      name,
      mime: file.type === "" ? "application/octet-stream" : file.type,
    });
    if (sessionId !== undefined) query.set("sessionId", sessionId);
    // The real type rides the query; the body is always raw bytes, typed so
    // the request is never one another origin could send without a preflight.
    const response = await fetch(`${base()}/api/artifacts?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
    if (!response.ok) throw await failure(response, "POST", "/api/artifacts");
    return (await response.json()) as ArtifactRow;
  },
  artifactsFor: (conversationId: string): Promise<ArtifactRow[]> =>
    getJson<ArtifactRow[]>(`/api/artifacts?conversationId=${encodeURIComponent(conversationId)}`),
};

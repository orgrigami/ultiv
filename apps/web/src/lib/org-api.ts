/**
 * The org client (phase 3): the org row, its flat teams, host-access
 * switches, the team page's summary, shared memory and templates.
 * Every change announces itself on `ORG_CHANGED` so the crew, the
 * team page and Settings read the same state without a reload.
 */
import type {
  AuditEvent,
  TeamInfo,
  TeamSummary,
  MemoryFact,
  MemoryProposal,
  OrgInfo,
  TemplateInfo,
  VmSettings,
} from "@spriessen/contracts";
import { getJson, send } from "./api.ts";

export type { TeamInfo, TeamSummary, OrgInfo, TemplateInfo, VmSettings };

/** GET /api/org — the org row, its teams and members. */
export interface OrgView {
  org: OrgInfo | null;
  teams: TeamInfo[];
  members: { accountId: string; role: string; teamId: string | null }[];
}

/** GET /api/org/host-access — the effective switch per bot, blocker named. */
export interface HostAccessMatrix {
  org: { hostAccess: boolean } | null;
  bots: {
    profileId: string;
    teamId: string | null;
    own: boolean;
    allowed: boolean;
    blockedBy: "org" | "team" | "bot" | null;
  }[];
}

export interface TeamInput {
  name?: string;
  vm?: VmSettings;
  hostAccess?: boolean;
  instructions?: string;
  netAllowlist?: string[];
  netOpen?: boolean;
}

/** GET /api/memory/v2?team= — the shared store and its proposals. */
export interface SharedMemory {
  facts: MemoryFact[];
  proposals: MemoryProposal[];
  openCount: number;
}

export const ORG_CHANGED = "spriessen:org-changed";

const changed = <T>(value: T): T => {
  window.dispatchEvent(new Event(ORG_CHANGED));
  return value;
};

const team = (id: string): string => `/api/org/teams/${encodeURIComponent(id)}`;

export const orgApi = {
  view: (): Promise<OrgView> => getJson<OrgView>("/api/org"),
  /** Cross-home reach rows (who reached which home, by which surface; no content). */
  reach: (limit = 100): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(`/api/audit?kind=reach&limit=${limit}`),
  /** One bot's export bundle (its definition and files), for a team export. */
  exportBot: (id: string): Promise<unknown> =>
    getJson<unknown>(`/api/profiles/${encodeURIComponent(id)}/export`),
  hostAccess: (): Promise<HostAccessMatrix> => getJson<HostAccessMatrix>("/api/org/host-access"),
  patchOrg: (patch: {
    name?: string;
    vm?: VmSettings;
    hostAccess?: boolean;
    netAllowlist?: string[];
    netOpen?: boolean;
  }): Promise<OrgInfo> => send<OrgInfo>("/api/org", "PATCH", patch).then(changed),
  createTeam: (input: TeamInput & { name: string }): Promise<TeamInfo> =>
    send<TeamInfo>("/api/org/teams", "POST", input).then(changed),
  patchTeam: (id: string, patch: TeamInput): Promise<TeamInfo> =>
    send<TeamInfo>(team(id), "PATCH", patch).then(changed),
  removeTeam: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(team(id), "DELETE").then(changed),
  summary: (id: string): Promise<TeamSummary> => getJson<TeamSummary>(`${team(id)}/summary`),
  sharedMemory: (id: string): Promise<SharedMemory> =>
    getJson<SharedMemory>(`/api/memory/v2?team=${encodeURIComponent(id)}`),
  decideShare: (id: string, proposalId: string, accept: boolean): Promise<{ status: string }> =>
    send<{ status: string }>(
      `/api/memory/v2/proposals/${encodeURIComponent(proposalId)}/${accept ? "accept" : "reject"}?team=${encodeURIComponent(id)}`,
      "POST",
    ),
  templates: (teamId: string): Promise<TemplateInfo[]> =>
    getJson<TemplateInfo[]>(`/api/org/templates?team=${encodeURIComponent(teamId)}`),
  publish: (input: {
    kind: "bot" | "instructions";
    teamId: string;
    botId: string;
  }): Promise<TemplateInfo> => send<TemplateInfo>("/api/org/templates", "POST", input),
  unpublish: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/org/templates/${encodeURIComponent(id)}`, "DELETE"),
  copyTemplate: (
    id: string,
    target: { teamId: string; botId?: string },
  ): Promise<{ id?: string }> =>
    send<{ id?: string }>(`/api/org/templates/${encodeURIComponent(id)}/copy`, "POST", target),
};

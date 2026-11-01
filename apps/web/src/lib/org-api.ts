/**
 * The org client (phase 3): the org row, its flat departments, host-access
 * switches, the department page's summary, shared memory and templates.
 * Every change announces itself on `ORG_CHANGED` so the crew, the
 * department page and Settings read the same state without a reload.
 */
import type {
  AuditEvent,
  DepartmentInfo,
  DepartmentSummary,
  MemoryFact,
  MemoryProposal,
  OrgInfo,
  TemplateInfo,
  VmSettings,
} from "@spriessen/contracts";
import { getJson, send } from "./api.ts";

export type { DepartmentInfo, DepartmentSummary, OrgInfo, TemplateInfo, VmSettings };

/** GET /api/org — the org row, its departments and members. */
export interface OrgView {
  org: OrgInfo | null;
  departments: DepartmentInfo[];
  members: { accountId: string; role: string; departmentId: string | null }[];
}

/** GET /api/org/host-access — the effective switch per bot, blocker named. */
export interface HostAccessMatrix {
  org: { hostAccess: boolean } | null;
  bots: {
    profileId: string;
    departmentId: string | null;
    own: boolean;
    allowed: boolean;
    blockedBy: "org" | "department" | "bot" | null;
  }[];
}

export interface DepartmentInput {
  name?: string;
  vm?: VmSettings;
  hostAccess?: boolean;
  instructions?: string;
  netAllowlist?: string[];
  netOpen?: boolean;
}

/** GET /api/memory/v2?department= — the shared store and its proposals. */
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

const dept = (id: string): string => `/api/org/departments/${encodeURIComponent(id)}`;

export const orgApi = {
  view: (): Promise<OrgView> => getJson<OrgView>("/api/org"),
  /** Cross-home reach rows (who reached which home, by which surface; no content). */
  reach: (limit = 100): Promise<AuditEvent[]> =>
    getJson<AuditEvent[]>(`/api/audit?kind=reach&limit=${limit}`),
  /** One bot's export bundle (its definition and files), for a department export. */
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
  createDepartment: (input: DepartmentInput & { name: string }): Promise<DepartmentInfo> =>
    send<DepartmentInfo>("/api/org/departments", "POST", input).then(changed),
  patchDepartment: (id: string, patch: DepartmentInput): Promise<DepartmentInfo> =>
    send<DepartmentInfo>(dept(id), "PATCH", patch).then(changed),
  removeDepartment: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(dept(id), "DELETE").then(changed),
  summary: (id: string): Promise<DepartmentSummary> =>
    getJson<DepartmentSummary>(`${dept(id)}/summary`),
  sharedMemory: (id: string): Promise<SharedMemory> =>
    getJson<SharedMemory>(`/api/memory/v2?department=${encodeURIComponent(id)}`),
  decideShare: (id: string, proposalId: string, accept: boolean): Promise<{ status: string }> =>
    send<{ status: string }>(
      `/api/memory/v2/proposals/${encodeURIComponent(proposalId)}/${accept ? "accept" : "reject"}?department=${encodeURIComponent(id)}`,
      "POST",
    ),
  templates: (departmentId: string): Promise<TemplateInfo[]> =>
    getJson<TemplateInfo[]>(`/api/org/templates?department=${encodeURIComponent(departmentId)}`),
  publish: (input: {
    kind: "bot" | "instructions";
    departmentId: string;
    botId: string;
  }): Promise<TemplateInfo> => send<TemplateInfo>("/api/org/templates", "POST", input),
  unpublish: (id: string): Promise<{ ok: boolean }> =>
    send<{ ok: boolean }>(`/api/org/templates/${encodeURIComponent(id)}`, "DELETE"),
  copyTemplate: (
    id: string,
    target: { departmentId: string; botId?: string },
  ): Promise<{ id?: string }> =>
    send<{ id?: string }>(`/api/org/templates/${encodeURIComponent(id)}/copy`, "POST", target),
};

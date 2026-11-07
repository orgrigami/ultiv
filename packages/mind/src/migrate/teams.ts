/**
 * Teams were called departments. Stored documents written before the rename
 * carry the old names; the docs that hold them (org, profiles, memory facts
 * and proposals) bump their version and run this on read, so every reader
 * and every commit sees only the new names, and the next write stores them.
 *
 * What changes: the keys (`departmentId` → `teamId`, `departments` →
 * `teams`, `department` → `team`), the `"department"` value of a home's
 * `kind` or a fact's `scope`, the `dept-shared` audit area, and the old
 * team tool names inside tool lists and approval rules (`department_create`
 * → `team_create`, `departments_list` → `teams_list`). What stays: ids.
 * A team created as `dept-marketing` keeps that id — it names the team's
 * VM folder, its shared store and its gid on disk.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const KEYS: Record<string, string> = {
  departmentId: "teamId",
  departments: "teams",
  department: "team",
};

/** Keys whose string value names a kind of thing, not an id. */
const KIND_KEYS = new Set(["kind", "scope", "area", "type"]);

const KIND_VALUES: Record<string, string> = {
  department: "team",
  "dept-shared": "team-shared",
};

/** Keys holding tool names or approval rules (`name` or `name:pattern`). */
const TOOL_KEYS = new Set(["toolAllowlist", "autoApprove"]);

/** `department_create` → `team_create`, `departments_list:x` → `teams_list:x`. */
export const renameTeamTool = (entry: string): string =>
  entry.replace(/^departments_/, "teams_").replace(/^department_/, "team_");

const walk = (value: Json, key: string | undefined): Json => {
  if (Array.isArray(value)) {
    if (key !== undefined && TOOL_KEYS.has(key))
      return value.map((item) =>
        typeof item === "string" ? renameTeamTool(item) : walk(item, undefined),
      );
    return value.map((item) => walk(item, undefined));
  }
  if (value !== null && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const [name, inner] of Object.entries(value)) {
      const next = KEYS[name] ?? name;
      // A row already written with the new name wins over a stale old one.
      if (next !== name && Object.hasOwn(value, next)) continue;
      out[next] = walk(inner, next);
    }
    return out;
  }
  if (typeof value === "string" && key !== undefined && KIND_KEYS.has(key))
    return KIND_VALUES[value] ?? value;
  return value;
};

/** The stored value with every legacy department name moved to its team name. */
export const renameLegacyTeams = <T>(value: T): T => walk(value as Json, undefined) as T;

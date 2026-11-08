/**
 * Tables: the typed half of the KV plane (docs/MEMORY.md "durable state").
 * A profile's own named tables with typed columns (string / number /
 * boolean), rows validated on write, everything durable in ONE doc. What
 * belongs here: ledgers, trackers, running lists — anything a sensor or a
 * routine accumulates that outgrows an 8 KB KV value. Scope and limits are
 * per PROFILE (a bot never sees a sibling's tables), rows cap at
 * TABLE_ROW_CAP and prune oldest-first rather than refusing mid-routine.
 */
import { randomUUID } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { InvalidInput } from "@spriessen/core";
import type { ConverseService } from "../converse/converse.ts";

export type TableColumnType = "string" | "number" | "boolean";

export type TableColumn = {
  readonly name: string;
  readonly type: TableColumnType;
};

export type TableRow = {
  readonly id: string;
  data: Record<string, string | number | boolean | null>;
  at: number;
};

export type StoredTable = {
  readonly id: string;
  readonly owner: string;
  readonly profile: string;
  readonly name: string;
  columns: TableColumn[];
  rows: TableRow[];
  readonly createdAt: number;
  updatedAt: number;
};

/** ≤ TABLE_LIMIT tables per profile, ≤ TABLE_ROW_CAP rows each. */
export const TABLE_LIMIT = 10;
export const TABLE_ROW_CAP = 1_000;
export const NAME_CHARS = 60;
export const TABLES_PER_OWNER_VIEW = 500;

export const TablesDoc = defineDoc<{ tables: StoredTable[] }>({
  kind: "ultiv.tables",
  version: 1,
  scope: "session",
  initial: () => ({ tables: [] }),
  checkpointWhen: () => true,
});

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(effect) as Promise<A>;

export type TableRowData = Record<string, string | number | boolean | null>;

const valueFits = (value: unknown, type: TableColumnType): boolean =>
  type === "string"
    ? typeof value === "string"
    : type === "number"
      ? typeof value === "number"
      : typeof value === "boolean";

/** One row checked against the table's columns; a sentence says what is off. */
const checkedRow = (
  table: StoredTable,
  row: TableRowData,
): { readonly data: TableRowData; readonly problem: string | null } => {
  const data: Record<string, string | number | boolean | null> = {};
  const problems: string[] = [];
  for (const column of table.columns) {
    const value = row[column.name];
    if (value === undefined || value === null) {
      data[column.name] = null;
      continue;
    }
    if (!valueFits(value, column.type)) {
      problems.push(`${column.name} must be ${column.type}`);
      continue;
    }
    if (typeof value === "string" && value.length > 8_000) {
      problems.push(`${column.name} is too long (8000 chars max)`);
      continue;
    }
    data[column.name] = value;
  }
  const unknown = Object.keys(row).filter((key) => !table.columns.some((c) => c.name === key));
  if (unknown.length > 0) problems.push(`unknown columns: ${unknown.join(", ")}`);
  return { data, problem: problems.length === 0 ? null : problems.join("; ") };
};

const scopeError = (name: string): InvalidInput =>
  new InvalidInput({ reason: `no table named "${name}" in this profile` });

export interface TablesService {
  readonly create: (input: {
    readonly owner: string;
    readonly profile: string;
    readonly name: string;
    readonly columns: readonly TableColumn[];
  }) => Promise<StoredTable>;
  readonly list: (owner: string, profile: string) => Promise<readonly StoredTable[]>;
  readonly rows: (
    owner: string,
    profile: string,
    name: string,
    limit?: number,
  ) => Promise<readonly TableRow[]>;
  readonly addRow: (
    owner: string,
    profile: string,
    name: string,
    row: TableRowData,
  ) => Promise<TableRow>;
  readonly setRow: (
    owner: string,
    profile: string,
    name: string,
    rowId: string,
    row: TableRowData,
  ) => Promise<TableRow>;
  readonly removeRow: (
    owner: string,
    profile: string,
    name: string,
    rowId: string,
  ) => Promise<boolean>;
  readonly remove: (owner: string, profile: string, name: string) => Promise<boolean>;
}

const commit = async <A>(
  converse: ConverseService,
  change: (tables: StoredTable[]) => A,
): Promise<A> => {
  try {
    return (await run(
      converse.docs.commit(async (tx) => {
        const draft = await tx.doc(TablesDoc);
        return change(draft.tables);
      }),
    )) as A;
  } catch (cause) {
    // The commit's Effect wrapper turns thrown InvalidInput into External;
    // callers (the tool, REST) get the sentence back.
    const inner = (cause as { readonly cause?: unknown }).cause;
    if (inner instanceof InvalidInput) throw inner;
    throw cause;
  }
};

const readAll = async (converse: ConverseService): Promise<StoredTable[]> =>
  (await run(converse.docs.snapshot(TablesDoc)))?.tables ?? [];

const findTable = (tables: readonly StoredTable[], owner: string, profile: string, name: string) =>
  tables.find((table) => table.owner === owner && table.profile === profile && table.name === name);

export const tablesService = (converse: ConverseService): TablesService => ({
  create: async ({ owner, profile, name, columns }) => {
    const clean = name.trim().slice(0, NAME_CHARS);
    if (clean === "") throw new InvalidInput({ reason: "the table name is empty" });
    if (columns.length === 0 || columns.length > 12) {
      throw new InvalidInput({ reason: "a table takes 1 to 12 columns" });
    }
    const seen = new Set<string>();
    for (const column of columns) {
      const key = column.name.trim().slice(0, 40);
      if (key === "") throw new InvalidInput({ reason: "a column name is empty" });
      if (seen.has(key)) throw new InvalidInput({ reason: `duplicate column "${key}"` });
      seen.add(key);
    }
    const normalized = columns.map((column) => ({
      name: column.name.trim().slice(0, 40),
      type: column.type,
    }));
    return commit(converse, (tables) => {
      const mine = tables.filter((table) => table.owner === owner && table.profile === profile);
      if (mine.some((table) => table.name === clean)) {
        throw new InvalidInput({ reason: `a table named "${clean}" already exists` });
      }
      if (mine.length >= TABLE_LIMIT) {
        throw new InvalidInput({
          reason: `this profile already has ${TABLE_LIMIT} tables; remove one first`,
        });
      }
      const table: StoredTable = {
        id: randomUUID(),
        owner,
        profile,
        name: clean,
        columns: normalized,
        rows: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      tables.push(table);
      return JSON.parse(JSON.stringify(table)) as StoredTable;
    });
  },
  list: async (owner, profile) => {
    const mine = (await readAll(converse)).filter(
      (table) => table.owner === owner && table.profile === profile,
    );
    return mine.toSorted((a, b) => b.updatedAt - a.updatedAt);
  },
  rows: async (owner, profile, name, limit = 100) => {
    const table = findTable(await readAll(converse), owner, profile, name);
    if (table === undefined) throw scopeError(name);
    return table.rows.slice(-limit).toReversed();
  },
  addRow: async (owner, profile, name, row) => {
    const added = await commit(converse, (tables) => {
      const table = findTable(tables, owner, profile, name);
      if (table === undefined) throw scopeError(name);
      const { data, problem } = checkedRow(table, row);
      if (problem !== null) throw new InvalidInput({ reason: problem });
      const entry: TableRow = { id: randomUUID().slice(0, 8), data, at: Date.now() };
      // The cap prunes OLDEST first: a running ledger keeps its newest rows.
      table.rows = [...table.rows, entry].slice(-TABLE_ROW_CAP);
      table.updatedAt = Date.now();
      return JSON.parse(JSON.stringify(entry)) as TableRow;
    });
    return added;
  },
  setRow: async (owner, profile, name, rowId, row) => {
    const table = findTable(await readAll(converse), owner, profile, name);
    if (table === undefined) throw scopeError(name);
    const { data, problem } = checkedRow(table, row);
    if (problem !== null) throw new InvalidInput({ reason: problem });
    return commit(converse, (tables) => {
      const target = findTable(tables, owner, profile, name);
      if (target === undefined) throw scopeError(name);
      const row = target.rows.find((entry) => entry.id === rowId);
      if (row === undefined) throw new InvalidInput({ reason: `no row "${rowId}"` });
      row.data = data;
      row.at = Date.now();
      target.updatedAt = Date.now();
      return JSON.parse(JSON.stringify(row)) as TableRow;
    });
  },
  removeRow: async (owner, profile, name, rowId) =>
    commit(converse, (tables) => {
      const table = findTable(tables, owner, profile, name);
      if (table === undefined) throw scopeError(name);
      const before = table.rows.length;
      table.rows = table.rows.filter((entry) => entry.id !== rowId);
      table.updatedAt = Date.now();
      return before !== table.rows.length;
    }),
  remove: async (owner, profile, name) =>
    commit(converse, (tables) => {
      const kept = tables.filter(
        (table) => !(table.owner === owner && table.profile === profile && table.name === name),
      );
      if (kept.length === tables.length) return false;
      tables.length = 0;
      tables.push(...kept);
      return true;
    }),
});

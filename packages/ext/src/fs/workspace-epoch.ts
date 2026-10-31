/**
 * A change counter per workspace directory. Tools that write the durable
 * tree outside bash (file_edit, file_delete) bump it; bash compares it with
 * the value its open VM was loaded at and re-pushes the tree when they
 * differ, so the VM never runs on stale files and its sync never writes an
 * old index over a newer one.
 */
import { resolve } from "node:path";

const epochs = new Map<string, number>();

export const workspaceEpoch = (dir: string): number => epochs.get(resolve(dir)) ?? 0;

export const bumpWorkspace = (dir: string): void => {
  const key = resolve(dir);
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
};

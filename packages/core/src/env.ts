/**
 * Product environment keys. Every key is `SPREISSEN_<NAME>`; the old
 * `ULTIV_<NAME>` spelling (from before the rename) is still read as a
 * deprecated fallback, with one warning per key per process, so an existing
 * `.env` keeps working until it is updated. The new name always wins.
 */
export const ENV_PREFIX = "SPREISSEN_";
export const LEGACY_ENV_PREFIX = "ULTIV_";

export type EnvSource = Readonly<Record<string, string | undefined>>;
export type Warn = (message: string) => void;

const warned = new Set<string>();

/** The one-line notice printed the first time a key is read by its old name. */
export const legacyEnvNotice = (name: string): string =>
  `${LEGACY_ENV_PREFIX}${name} is deprecated: rename it to ${ENV_PREFIX}${name} (the old name still works for now).`;

/** Print the deprecation notice for `name`, at most once per process. */
export const warnLegacyEnv = (name: string, warn: Warn = console.warn): void => {
  if (warned.has(name)) return;
  warned.add(name);
  warn(legacyEnvNotice(name));
};

/** Read `SPREISSEN_<name>`, else the deprecated `ULTIV_<name>` (warning once). */
export const readEnv = (
  name: string,
  env: EnvSource = process.env,
  warn: Warn = console.warn,
): string | undefined => {
  const current = env[`${ENV_PREFIX}${name}`];
  if (current !== undefined) return current;
  const legacy = env[`${LEGACY_ENV_PREFIX}${name}`];
  if (legacy !== undefined) warnLegacyEnv(name, warn);
  return legacy;
};

/** Tests only: forget which keys already warned. */
export const resetLegacyEnvWarnings = (): void => warned.clear();

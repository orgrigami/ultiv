/**
 * Device-local keys live under `spriessen.`. Two older prefixes are still
 * adopted: `spreissen.` (the short-lived misspelling) and `ultiv.` (from
 * before the rename). `adoptLegacyKey` runs before a key is read: when the
 * new key is empty and an old one holds a value, the newest old value is
 * copied over and every old key removed, so a device keeps its theme and
 * dismissals and a later "back to default" (which clears the new key) cannot
 * resurrect an old one.
 */
type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function adoptLegacyKey(
  next: string,
  legacy: string | readonly string[],
  store?: KeyStore,
): void {
  try {
    const target = store ?? globalThis.localStorage;
    if (target === undefined) return;
    const olds = typeof legacy === "string" ? [legacy] : legacy;
    if (target.getItem(next) === null) {
      const found = olds.map((key) => target.getItem(key)).find((value) => value !== null);
      if (found === undefined || found === null) return;
      target.setItem(next, found);
    }
    for (const key of olds) target.removeItem(key);
  } catch {
    // Private mode or a full quota: the old value simply isn't carried over.
  }
}

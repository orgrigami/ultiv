/**
 * Device-local keys moved from the pre-rename `ultiv.` prefix to
 * `spreissen.`. `adoptLegacyKey` runs before a key is read: when the new key
 * is empty and the old one holds a value, the value is copied over and the
 * old key removed, so a device keeps its theme and dismissals and a later
 * "back to default" (which clears the new key) cannot resurrect the old one.
 */
type KeyStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function adoptLegacyKey(next: string, legacy: string, store?: KeyStore): void {
  try {
    const target = store ?? globalThis.localStorage;
    if (target === undefined) return;
    if (target.getItem(next) !== null) return;
    const old = target.getItem(legacy);
    if (old === null) return;
    target.setItem(next, old);
    target.removeItem(legacy);
  } catch {
    // Private mode or a full quota: the old value simply isn't carried over.
  }
}

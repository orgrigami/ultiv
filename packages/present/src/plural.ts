const rules = new Intl.PluralRules("en");

/** English plural through the plural system: `plural(n, "task", "tasks")`. */
export function plural(count: number, one: string, other: string): string {
  return rules.select(count) === "one" ? one : other;
}

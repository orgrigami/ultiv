/**
 * Theme control: dark by default, following the OS, with an
 * explicit light/dark pin the owner can set once and is remembered per device.
 * Applied before the first render so there is no flash.
 */
import { adoptLegacyKey } from "./stored-key.ts";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "spriessen.theme";
/** Newest first: the short-lived misspelt prefix, then the pre-rename one. */
const LEGACY_KEYS = ["spreissen.theme", "ultiv.theme"];
const query = (): MediaQueryList => window.matchMedia("(prefers-color-scheme: dark)");

function apply(): void {
  const choice = themeChoice();
  const dark = choice === "dark" || (choice === "system" && query().matches);
  document.documentElement.classList.toggle("dark", dark);
}

export function themeChoice(): ThemeChoice {
  if (typeof window === "undefined") return "system";
  adoptLegacyKey(KEY, LEGACY_KEYS);
  const saved = window.localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") window.localStorage.removeItem(KEY);
  else window.localStorage.setItem(KEY, choice);
  apply();
}

/** Called once before the first render; keeps following the OS while on system. */
export function followColorScheme(): void {
  if (typeof window === "undefined") return;
  apply();
  query().addEventListener("change", apply);
}

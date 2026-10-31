/**
 * The one navigation model, shared by the phone tab bar and the desktop rail:
 * Chat · Needs you · Crew · Settings. Every route maps to one of the four (or
 * none), so both bars mark the same place as current.
 */
export type Section = "chat" | "needs" | "crew" | "settings";

/** Path prefixes per section; first match wins. */
const MATCHES: readonly (readonly [string, Section])[] = [
  ["/c/", "chat"],
  ["/history", "chat"],
  ["/needs", "needs"],
  ["/crew", "crew"],
  ["/bots", "crew"],
  ["/routines", "crew"],
  ["/rooms", "crew"],
  ["/settings", "settings"],
  ["/tools", "settings"],
  ["/connectors", "settings"],
  ["/skills", "settings"],
  ["/vault", "settings"],
];

export function sectionOf(path: string): Section | null {
  if (path === "/" || path === "") return "chat";
  return MATCHES.find(([prefix]) => path === prefix || path.startsWith(prefix))?.[1] ?? null;
}

export const SECTION_LABEL: Record<Section, string> = {
  chat: "Chat",
  needs: "Needs you",
  crew: "Crew",
  settings: "Settings",
};

/** The badge text for a count: nothing at zero, "9+" past nine. */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 9 ? "9+" : String(count);
}

/**
 * Old pages that moved, with where they live now. Their routes stay so
 * bookmarks and push links (the memory tidy still links /bots) keep working.
 */
export const MOVED = { "/bots": "/crew" } as const;

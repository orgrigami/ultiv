/**
 * The one navigation model, shared by the phone tab bar and the sidebar:
 * Now · Chats · Crew · Settings. Now is oversight (what waits on you first,
 * then running work, goals and new files); Chats is conversation (the chat
 * with the current bot and Past chats); Crew is the bots; Settings the rest.
 * Every route maps to one of the four (or none), so both bars mark the same
 * place as current. Find (Cmd/Ctrl-K) sits beside them on every width.
 */
export type Section = "now" | "chats" | "crew" | "settings";

/** The four, in nav order. */
export const SECTIONS: readonly Section[] = ["now", "chats", "crew", "settings"];

/** Path prefixes per section, matched on whole segments; first match wins. */
const MATCHES: readonly (readonly [string, Section])[] = [
  ["/now", "now"],
  ["/needs", "now"],
  ["/c/", "chats"],
  ["/history", "chats"],
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
  if (path === "/" || path === "") return "chats";
  return (
    MATCHES.find(
      ([prefix]) =>
        path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
    )?.[1] ?? null
  );
}

export const SECTION_LABEL: Record<Section, string> = {
  now: "Now",
  chats: "Chats",
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
 * bookmarks and pushes sent before the move keep working.
 */
export const MOVED = { "/bots": "/crew", "/needs": "/now" } as const;

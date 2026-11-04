/**
 * The terminal's palette: the web's world in truecolor — a deep blue-black
 * ground, warm ivory ink, one amber for "working", one red reserved for what
 * needs the owner, green for settled (apps/web/src/index.css and
 * docs/design/brand.md are the authority; these are their dark-theme values).
 */
export const THEME = {
  ground: "#0d0e14",
  raised: "#161822",
  rule: "#2a2d3a",
  ink: "#ece9e1",
  muted: "#8d8f9c",
  faint: "#5d6070",
  live: "#efba64",
  signal: "#ef6b5b",
  ok: "#7cc49a",
  owner: "#b9c3e0",
} as const;

export type ThemeColor = (typeof THEME)[keyof typeof THEME];

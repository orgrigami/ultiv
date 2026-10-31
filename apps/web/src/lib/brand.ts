/**
 * The brand, in one place: name, wordmark, tagline, the mark's geometry and
 * the few fixed colors the icons and manifest need. The app's live colors are
 * tokens in index.css; these hex values match the dark theme's ink and the
 * amber accent so the installed icon and the running app look like one thing.
 */

export const BRAND = {
  /** In sentences and titles. */
  name: "Spreissen",
  /** The lowercase wordmark beside the mark. */
  wordmark: "spreissen",
  tagline: "Your bots, on your own server.",
  /** The manifest and store-style description: what it is, plainly. */
  description: "Chat with your bots, follow their work and approve what needs you.",
  colors: {
    /** Dark theme background (--gray-2 dark). */
    ink: "#0d0e14",
    /** Light theme background (--gray-2 light). */
    paper: "#f5f4f0",
    /** The one accent (--accent-tone dark). */
    amber: "#efba64",
  },
} as const;

/** "Past chats · Spreissen": every screen's document title. */
export function pageTitle(screen?: string | undefined): string {
  const trimmed = screen?.trim() ?? "";
  return trimmed === "" ? BRAND.name : `${trimmed} · ${BRAND.name}`;
}

/**
 * The mark: a soft amber gumdrop with two eyes and a sprout: a small
 * growing thing, on a 64×64 grid. The same geometry draws the in-app mark, the
 * favicon and the install icons.
 */
export const MARK = {
  viewBox: 64,
  body: "M32 16c13.5 0 23 9.5 23 23.5 0 10.5-7.5 16.5-23 16.5S9 50 9 39.5C9 25.5 18.5 16 32 16z",
  sprout: "M31 17.5c-.4-5.6 2.6-9.6 9.5-10.8-.3 6.4-3.8 10-9.5 10.8z",
  eyes: [
    { cx: 25.5, cy: 36, rx: 3, ry: 4.2 },
    { cx: 38.5, cy: 36, rx: 3, ry: 4.2 },
  ],
} as const;

/**
 * The mark as a standalone SVG. `pad` (0–0.4) is the share of the canvas
 * left around the blob: 0.16 for the app icon, 0.26 keeps a maskable icon's
 * blob inside the safe circle. `rounded` gives the plate iOS-style corners.
 */
export function markSvg({
  background = BRAND.colors.ink,
  body = BRAND.colors.amber,
  eyes = BRAND.colors.ink,
  pad = 0.16,
  rounded = true,
}: {
  background?: string | null;
  body?: string;
  eyes?: string;
  pad?: number;
  rounded?: boolean;
} = {}): string {
  const size = 512;
  const inner = size * (1 - 2 * pad);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const scale = round(inner / MARK.viewBox);
  const offset = round(size * pad);
  const plate =
    background === null
      ? ""
      : `<rect width="${size}" height="${size}"${rounded ? ' rx="112"' : ""} fill="${background}"/>`;
  const eyeShapes = MARK.eyes
    .map((eye) => `<ellipse cx="${eye.cx}" cy="${eye.cy}" rx="${eye.rx}" ry="${eye.ry}"/>`)
    .join("");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">` +
    plate +
    `<g transform="translate(${offset} ${offset}) scale(${scale})">` +
    `<path d="${MARK.body}" fill="${body}"/>` +
    `<path d="${MARK.sprout}" fill="${body}"/>` +
    `<g fill="${eyes}">${eyeShapes}</g>` +
    `</g></svg>\n`
  );
}

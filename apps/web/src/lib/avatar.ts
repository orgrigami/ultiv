/**
 * Bot characters: a small creature per bot, picked deterministically from
 * its id (or name), so a bot looks the same on every screen and device. Each
 * trait comes from its own slice of one 32-bit hash: body shape, eyes, mouth,
 * a top detail and one of six palette hues (--char-1 … --char-6).
 */

export const CHARACTER_HUES = 6;

export interface Character {
  /** 0 gumdrop, 1 round, 2 squircle, 3 bean. */
  readonly body: 0 | 1 | 2 | 3;
  /** 0 ovals, 1 dots, 2 wide ovals, 3 happy arcs. */
  readonly eyes: 0 | 1 | 2 | 3;
  /** 0 none, 1 smile, 2 "o", 3 cheeks. */
  readonly mouth: 0 | 1 | 2 | 3;
  /** 0 none, 1 sprout, 2 antenna, 3 ears. */
  readonly top: 0 | 1 | 2 | 3;
  /** 1–6: which --char-N colors the body. */
  readonly hue: 1 | 2 | 3 | 4 | 5 | 6;
}

/** FNV-1a, 32-bit: tiny, stable across engines, well spread for short ids. */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // A final avalanche so ids that differ in one character differ in every trait.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  return hash >>> 0;
}

const four = (value: number): 0 | 1 | 2 | 3 => (value & 3) as 0 | 1 | 2 | 3;

export function characterOf(seed: string): Character {
  const hash = hashSeed(seed.trim().toLowerCase() || "?");
  return {
    body: four(hash),
    eyes: four(hash >>> 2),
    mouth: four(hash >>> 4),
    top: four(hash >>> 6),
    hue: (((hash >>> 8) % CHARACTER_HUES) + 1) as Character["hue"],
  };
}

/** The seed: the stable id when there is one, else the name. */
export const seedOf = (id: string | undefined, name: string): string =>
  id !== undefined && id !== "" ? id : name;

/** Geometry on a 64×64 grid; the avatar draws these. */
export const CHARACTER_PATHS = {
  body: [
    "M32 18c11.5 0 19.5 8 19.5 20 0 9-6.5 14-19.5 14S12.5 47 12.5 38c0-12 8-20 19.5-20z",
    "M32 19a17 17 0 1 1 0 34a17 17 0 1 1 0-34z",
    "M32 19c13 0 17 4 17 17s-4 17-17 17-17-4-17-17 4-17 17-17z",
    "M32 22c12 0 20 5 20 15 0 9-8 14-20 14s-20-5-20-14c0-10 8-15 20-15z",
  ],
  sprout: "M31 19.5c-.3-4.6 2.2-7.9 7.8-8.9-.3 5.3-3.1 8.2-7.8 8.9z",
  smile: "M28.5 43.5q3.5 3 7 0",
  happyEye: (cx: number) => `M${cx - 3} 36q3-3.6 6 0`,
} as const;

/**
 * The star catalog: every bot is a catalogued object. Its id hashes to one of
 * the seven spectral classes, one of seven letters O B A F G K M, which gives
 * avatars and presence marks a stable legible tint, identity not decoration.
 */
export type SpectralClass = "o" | "b" | "a" | "f" | "g" | "k" | "m";

const CLASSES: readonly SpectralClass[] = ["o", "b", "a", "f", "g", "k", "m"];

export function spectralClassOf(id: string): SpectralClass {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return CLASSES[Math.abs(hash) % CLASSES.length] as SpectralClass;
}

export function spectralClass(id: string): `spec-${SpectralClass}` {
  return `spec-${spectralClassOf(id)}`;
}

export function spectralLabelOf(id: string): string {
  const letter = spectralClassOf(id).toUpperCase();
  return `spectral ${letter}`;
}

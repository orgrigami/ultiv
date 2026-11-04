/**
 * The predicate vocabulary: the few relations where a newer value REPLACES
 * the older one ("lives_in Jakarta" → "lives_in Bandung"). The write rule
 * that supersedes on them only fires when two facts use the same predicate
 * name, so the extraction prompt names this list and every triple is
 * normalized on the way in: free-form predicates fold onto the canonical
 * ones (EN + ID), and subjects/objects compare case- and accent-blind.
 */
import type { FactTriple } from "@spriessen/contracts";
import { normalize } from "./text.ts";

/** Canonical functional predicates: one current value per subject. */
export const FUNCTIONAL_PREDICATES = [
  "name_is",
  "lives_in",
  "works_at",
  "role_is",
  "timezone_is",
  "born_on",
  "birthday_on",
  "spouse_of",
  "status_is",
  "located_in",
] as const;

const FUNCTIONAL = new Set<string>(FUNCTIONAL_PREDICATES);

/** Common ways of saying a functional predicate, folded onto it. */
const SYNONYMS: Readonly<Record<string, string>> = {
  live_in: "lives_in",
  lives_at: "lives_in",
  living_in: "lives_in",
  resides_in: "lives_in",
  reside_in: "lives_in",
  stays_in: "lives_in",
  moved_to: "lives_in",
  tinggal_di: "lives_in",
  domisili_di: "lives_in",
  works_for: "works_at",
  work_at: "works_at",
  employed_at: "works_at",
  employed_by: "works_at",
  bekerja_di: "works_at",
  kerja_di: "works_at",
  job_title: "role_is",
  role: "role_is",
  works_as: "role_is",
  title_is: "role_is",
  jabatan: "role_is",
  name: "name_is",
  named: "name_is",
  called: "name_is",
  is_called: "name_is",
  bernama: "name_is",
  nama: "name_is",
  birthday: "birthday_on",
  birthday_is: "birthday_on",
  has_birthday_on: "birthday_on",
  ulang_tahun: "birthday_on",
  born: "born_on",
  born_in: "born_on",
  date_of_birth: "born_on",
  lahir: "born_on",
  married_to: "spouse_of",
  wife_of: "spouse_of",
  husband_of: "spouse_of",
  spouse: "spouse_of",
  menikah_dengan: "spouse_of",
  timezone: "timezone_is",
  time_zone_is: "timezone_is",
  in_timezone: "timezone_is",
  status: "status_is",
  location_is: "located_in",
  is_located_in: "located_in",
  based_in: "located_in",
  berlokasi_di: "located_in",
};

/** snake_case, then folded onto the canonical name when it is a synonym. */
export const normalizePredicate = (predicate: string): string => {
  const snake = normalize(predicate)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return SYNONYMS[snake] ?? snake;
};

export const isFunctional = (predicate: string): boolean =>
  FUNCTIONAL.has(normalizePredicate(predicate));

/** A triple as stored: canonical predicate, trimmed subject and object. */
export const normalizeTriple = (triple: FactTriple | null): FactTriple | null => {
  if (triple === null) return null;
  const s = triple.s.trim();
  const o = triple.o.trim();
  const p = normalizePredicate(triple.p);
  if (s === "" || o === "" || p === "") return null;
  return { s, p, o };
};

/** Same subject or object, whatever the letter case or accents. */
export const sameTerm = (a: string, b: string): boolean => normalize(a) === normalize(b);

/** The vocabulary line the extraction prompt carries. */
export const PREDICATE_GUIDE =
  `When the fact states one of these, use exactly this predicate: ${FUNCTIONAL_PREDICATES.join(", ")}. ` +
  'The subject is a name (the owner is "owner" when unnamed), never a pronoun.';

import { arr, nul, num, obj, oneOf, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { HomeRefSchema } from "./org.ts";

/**
 * Vault item kinds. `login`/`card`/`key`/`note` are `secret` (use-only: the
 * model sees metadata + a mask, and triggers redemptions); `contact` is
 * `reference` (readable: who to email, where to ship).
 */
export const VaultKindSchema = oneOf(["login", "card", "contact", "key", "note"]);

export type VaultKind = Static<typeof VaultKindSchema>;

/** The metadata + masked preview the world (and the model) may see. Never secret bytes. */
export const VaultItemInfoSchema = obj(
  {
    id: str(),
    owner: str(),
    /** null = owner-shared across this owner's profiles; else isolated to one profile. */
    profile: union([str(), nul()]),
    kind: VaultKindSchema,
    name: str(),
    access: oneOf(["secret", "reference"]),
    /** Masked hint, e.g. `harry@gmail.com` or `VISA •••• 4242`. */
    masked: str(),
    createdAt: num(),
    lastUsedAt: union([num(), nul()]),
    /**
     * The home (phase 4 slice 6) the item belongs to: one team, or the
     * org. Absent on rows stored before the field existed — they read as the
     * org (owner-level items are org items; recorded decision). A
     * profile-scoped item's visibility is its profile's alone, so its home
     * stays unstored; grants name the home when one is shared.
     */
    home: opt(HomeRefSchema),
  },
  { open: true },
);

export type VaultItemInfo = Static<typeof VaultItemInfoSchema>;

export const VaultListSchema = arr(VaultItemInfoSchema);

export type VaultList = Static<typeof VaultListSchema>;

/**
 * The human-only create payload. Each kind carries its secret fields; they are
 * sealed server-side and never appear in any response or tool output.
 */
export const VaultItemCreateSchema = obj(
  {
    kind: VaultKindSchema,
    name: str({ minLength: 1, maxLength: 120 }),
    /** Profile scope; omit/null = owner-shared. */
    profile: opt(union([str(), nul()])),
    /**
     * The team the item belongs to (phase 4 slice 6); omit/null = the
     * org. Refused when a profile scope is also given (a profile-scoped item
     * follows its bot's home, not a second one).
     */
    teamId: opt(union([str(), nul()])),
    login: opt(
      obj(
        {
          url: opt(str()),
          username: str(),
          password: str(),
          totp: opt(str()),
        },
        { open: true },
      ),
    ),
    card: opt(
      obj(
        {
          brand: opt(str()),
          number: str(),
          exp: str(),
          cvc: str(),
          billing: opt(str()),
        },
        { open: true },
      ),
    ),
    contact: opt(
      obj(
        {
          email: opt(str()),
          phone: opt(str()),
          note: opt(str()),
        },
        { open: true },
      ),
    ),
    key: opt(obj({ service: opt(str()), secret: str() }, { open: true })),
    note: opt(obj({ secret: str() }, { open: true })),
  },
  { open: true },
);

export type VaultItemCreate = Static<typeof VaultItemCreateSchema>;

/** A readable contact, resolved from reference-class items. */
export const VaultContactSchema = obj(
  {
    id: str(),
    name: str(),
    email: union([str(), nul()]),
    phone: union([str(), nul()]),
    note: union([str(), nul()]),
    profile: union([str(), nul()]),
  },
  { open: true },
);

export type VaultContact = Static<typeof VaultContactSchema>;

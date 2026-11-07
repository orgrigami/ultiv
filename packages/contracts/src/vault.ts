import { Type, type Static } from "typebox";
import { HomeRefSchema } from "./org.ts";

/**
 * Vault item kinds. `login`/`card`/`key`/`note` are `secret` (use-only: the
 * model sees metadata + a mask, and triggers redemptions); `contact` is
 * `reference` (readable: who to email, where to ship).
 */
export const VaultKindSchema = Type.Union([
  Type.Literal("login"),
  Type.Literal("card"),
  Type.Literal("contact"),
  Type.Literal("key"),
  Type.Literal("note"),
]);

export type VaultKind = Static<typeof VaultKindSchema>;

/** The metadata + masked preview the world (and the model) may see. Never secret bytes. */
export const VaultItemInfoSchema = Type.Object({
  id: Type.String(),
  owner: Type.String(),
  /** null = owner-shared across this owner's profiles; else isolated to one profile. */
  profile: Type.Union([Type.String(), Type.Null()]),
  kind: VaultKindSchema,
  name: Type.String(),
  access: Type.Union([Type.Literal("secret"), Type.Literal("reference")]),
  /** Masked hint, e.g. `harry@gmail.com` or `VISA •••• 4242`. */
  masked: Type.String(),
  createdAt: Type.Number(),
  lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
  /**
   * The home (phase 4 slice 6) the item belongs to: one team, or the
   * org. Absent on rows stored before the field existed — they read as the
   * org (owner-level items are org items; recorded decision). A
   * profile-scoped item's visibility is its profile's alone, so its home
   * stays unstored; grants name the home when one is shared.
   */
  home: Type.Optional(HomeRefSchema),
});

export type VaultItemInfo = Static<typeof VaultItemInfoSchema>;

export const VaultListSchema = Type.Array(VaultItemInfoSchema);

export type VaultList = Static<typeof VaultListSchema>;

/**
 * The human-only create payload. Each kind carries its secret fields; they are
 * sealed server-side and never appear in any response or tool output.
 */
export const VaultItemCreateSchema = Type.Object({
  kind: VaultKindSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  /** Profile scope; omit/null = owner-shared. */
  profile: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /**
   * The team the item belongs to (phase 4 slice 6); omit/null = the
   * org. Refused when a profile scope is also given (a profile-scoped item
   * follows its bot's home, not a second one).
   */
  teamId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  login: Type.Optional(
    Type.Object({
      url: Type.Optional(Type.String()),
      username: Type.String(),
      password: Type.String(),
      totp: Type.Optional(Type.String()),
    }),
  ),
  card: Type.Optional(
    Type.Object({
      brand: Type.Optional(Type.String()),
      number: Type.String(),
      exp: Type.String(),
      cvc: Type.String(),
      billing: Type.Optional(Type.String()),
    }),
  ),
  contact: Type.Optional(
    Type.Object({
      email: Type.Optional(Type.String()),
      phone: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
  ),
  key: Type.Optional(Type.Object({ service: Type.Optional(Type.String()), secret: Type.String() })),
  note: Type.Optional(Type.Object({ secret: Type.String() })),
});

export type VaultItemCreate = Static<typeof VaultItemCreateSchema>;

/** A readable contact, resolved from reference-class items. */
export const VaultContactSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  email: Type.Union([Type.String(), Type.Null()]),
  phone: Type.Union([Type.String(), Type.Null()]),
  note: Type.Union([Type.String(), Type.Null()]),
  profile: Type.Union([Type.String(), Type.Null()]),
});

export type VaultContact = Static<typeof VaultContactSchema>;

/**
 * Every string the memory panel shows, hard-coded English, in one place
 * (the owner's app ships en-only; same pattern as the other *-text modules).
 */

export const panelTitle = (name: string): string => `What ${name} remembers`;

export const TABS = {
  facts: "Facts",
  people: "People & things",
  core: "Core",
  tidy: "Tidy",
  files: "Files",
} as const;

export const factsEmpty = (name: string): string =>
  `Nothing yet. Facts ${name} keeps about its work show up here, and you can edit or delete them.`;
export const factsBotTitle = "This bot";
export const factsSharedTitle = "Shared · the whole workspace";
export const searchLabel = "Search facts";
export const searchPlaceholder = "Search facts…";
export const noMatches = "No facts match.";
export const viewCurrent = "Current";
export const viewHistory = "History";
export const historyIntro =
  "Superseded and archived facts, grouped under the fact that replaced them.";
export const historyOrphans = "Earlier versions (their successor is gone)";
export const historyArchived = "Archived";
export const editLabel = "Edit";
export const editNote =
  "Saving tombstones the old fact and re-adds your version — the bot recalls only the new text.";
export const editAria = (text: string): string => `Edit fact: ${text.slice(0, 40)}`;
export const factTextLabel = "Fact text";
export const savingLabel = "Saving…";
export const forgottenTitle = "Forgotten";
export const forgottenIntro =
  "Forgotten facts keep their text until you purge — restore them, or purge from the Tidy tab.";
export const restoreLabel = "Restore";
export const restoringLabel = "Restoring…";
export const forgottenEmpty = "Nothing forgotten.";

export const entitiesIntro =
  "People, pets, places and projects the bot resolved from its facts. Tap one for its card.";
export const entitiesEmpty = "No entities yet — they appear as facts resolve.";
export const ENTITY_TYPES: Record<string, string> = {
  person: "Person",
  pet: "Pet",
  place: "Place",
  org: "Org",
  project: "Project",
  thing: "Thing",
  concept: "Concept",
  event: "Event",
  self: "The bot itself",
};
export const aliasesLabel = "Also known as";
export const factsAboutLabel = "Facts about";
export const mergeWithLabel = "Merge with…";
export const mergeNote =
  "Merging needs the entity-merge detector — it isn't wired to the API yet, so this stays disabled.";
export const mergedNote = (target: string): string => `Merged into ${target}.`;
export const entityAria = (name: string): string => `Open ${name}`;
export const summaryLabel = "Summary";

export const coreEditAria = (text: string): string => `Edit core line: ${text.slice(0, 40)}`;
export const coreEditTextLabel = "Core line text";
export const coreSavingLabel = "Saving…";
export const reorderNote = "Order is the server's — drag-to-reorder isn't in the API yet.";
export const pinNote = "Pin is set when a line is added; toggling isn't in the API yet.";
export const pinOnAddLabel = "Pin";
export const addPlaceholder = (name: string): string => `Something ${name} should always know…`;
export const addLabel = (name: string): string => `Something ${name} should always know`;

export const forgetTitle = "Forget this?";
export const forgetWarning = (name: string): string =>
  `${name} will stop recalling it. It stays as a restorable tombstone until you purge.`;
export const forgetAria = (text: string): string => `Forget: ${text.slice(0, 40)}`;

export const coreIntro = "The few lines that sit in every prompt — always in context.";
export const coreEmpty = (name: string): string =>
  `Empty. Core lines are always in ${name}'s context, so keep them short and few.`;
export const coreSharedTitle = "Shared · the whole workspace";
export const coreSharedNote =
  "Every bot sees these. Removing one removes it everywhere — this cannot be undone.";
export const coreBotTitle = "This bot";
export const coreAddLabel = "A core line";
export const coreAddPlaceholder = "A short line always in context…";
export const coreTargetLabel = "Add to";
export const coreTargetBot = "This bot";
export const coreTargetShared = "Shared (workspace)";
export const coreRemoveTitle = "Remove this core line?";
export const coreRemoveWarning =
  "The bot stops seeing it from its next turn. This cannot be undone.";
export const coreRemoveAria = (text: string): string => `Remove core line: ${text.slice(0, 40)}`;
export const pinnedLabel = "pinned";
export const words = (count: number, budget: number): string => `${count} / ${budget} words`;
export const lineWords = (count: number): string => `${count} / 25 words`;
export const draftTooLong = "Keep the line to 25 words or fewer.";
export const overBudget = (budget: number): string =>
  `Over the ${budget}-word budget for this store.`;

/** Word budgets the server enforces on core stores. */
export const SHARED_CORE_BUDGET = 120;
export const BOT_CORE_BUDGET = 80;
export const CORE_LINE_LIMIT = 25;

/** Counts words the way the server's budget check does (whitespace runs). */
export const countWords = (text: string): number =>
  text.trim() === "" ? 0 : text.trim().split(/\s+/).length;

export const tidyIntro = "The Sunday tidy proposes; nothing changes until you accept.";
export const tidyEmpty = "No suggestions right now.";
export const tidyOpenBadge = (count: number): string => `${count} open`;
export const tidyRunLabel = "Run tidy now";
export const tidyRunning = "Running tidy…";
export const tidyResult = (count: number): string =>
  count === 0 ? "0 suggestions" : `${count} new suggestion${count === 1 ? "" : "s"}`;
export const tidyRunError = "The tidy run failed.";

export const PROPOSAL_KINDS: Record<string, string> = {
  merge: "Merge",
  conflict: "Conflict",
  stale: "Stale",
  "entity-merge": "Entity merge",
  secret: "Secret",
  "core-fix": "Core fix",
  archive: "Archive",
  backfill: "Backfill",
};
export const affectedTitle = "Affected facts:";
export const willForget =
  "Accepting forgets these facts — they become restorable tombstones, but the bot stops recalling them.";
export const acceptLabel = "Accept";
export const acceptingLabel = "Accepting…";
export const rejectLabel = "Not now";
export const rejectingLabel = "Dismissing…";
export const rejectNote = "Permanent: a dismissed suggestion never comes back.";
export const editAcceptLabel = "Edit & accept";
export const saveAcceptLabel = "Save & accept";
export const cancelLabel = "Cancel";

export const purgeLabel = "Purge forgotten";
export const purgeTitle = "Purge forgotten facts?";
export const purgeWarning =
  "Every forgotten fact loses its text for good. Tombstones stay, but the words are gone. This cannot be undone.";
export const purgeListTitle = "These facts lose their text:";

export const kvEmpty = (name: string): string =>
  `Nothing yet. ${name} notes what it has already done here, so it doesn't do it twice.`;
export const kvDeleteWarning = (name: string): string =>
  `${name} may redo work this marker was guarding against. This cannot be undone.`;

export const filesEmpty = "No files yet.";

export const footer = `Shared lines and facts are marked "Shared" — changes apply to every bot in the workspace. Forgetting an item hides it until you purge.`;

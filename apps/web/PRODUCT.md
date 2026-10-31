# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

A single owner (developer-grade power user) operating a crew of persistent AI entities ("bots": none on a fresh install, then owner-created ones like Rook). Primary scene: long dark-room sessions at a desk over a tailnet, delegating and monitoring autonomous work; secondary scene: the phone (PWA, push-tapped) checking on what the crew did. Unauthenticated guests exist only as a degraded fallback and never drive design.

Derived from the repo (owner-scoped everything, single-header IdP seam, tailnet serving) and the owner's 2026-10-30 redesign brief; the init interview was waived by explicit directive in that brief, so this record is brief+evidence derived and confirmed by use.

## Product Purpose

spreissen is one runtime hosting many AI entities: each bot has its own persona, persistent memory, artifacts, vault scope, skills, tool allowlist, and budgets. The owner chats with them, spawns background tasks, watches them message each other in rooms, approves gated actions, and defines routines (cron, webhooks, sensors) that wake them. Success: the owner trusts the crew with real commitments and leaves it working overnight.

## Positioning

Entity-first AI workspace: one runtime, one entity per profile. The owner's relationship is with named, persistent personas (e.g. Rook) that remember, hold credentials, and work unattended — not with ephemeral chat sessions. A neighboring chat product cannot truthfully copy the per-entity memory/artifact/vault/audit substrate or the inter-bot mailbox with budgets and escalation.

## Operating Context

Self-hosted on the owner's Mac (tmux-managed dev server), served over Tailscale HTTPS as a PWA with web push; also plain localhost. The owner reads bot transcripts daily, incl. long tool traces; approves or denies gated tool calls from an inbox; accepts/rejects memory proposals the weekly tidy proposes; edits skills the bots propose; never sees raw secrets (vault masks them by construction). Product vocabulary to preserve: bots, profiles, rooms ("Bot talks"), tasks, skills, vault, routines, memory (core/facts/proposals), approvals, Jev (the built-in decision faculty, part of each bot's own mind).

## Capabilities and Constraints

Chat with steering (default) and redirect (stop at safe point); per-session model/effort configuration from a live models.dev catalog; tasks are durable sub-agent conversations with live transcripts, running caps, and wake-the-parent semantics; artifacts are per-owner/per-profile files with REST byte access; skills are per-bot procedure libraries with versions, references, and proposals; the credential broker spends sealed vault secrets only within bindings; routines write write-ahead receipts; audit is append-only and per-profile; memory v2 has five tiers with bilingual recall. Client constraints: React 19 + TanStack Router (file-based), shadcn on Base UI (render prop, not asChild), Tailwind 4 CSS-first tokens, no Effect in the client, chord socket for transcripts + plain REST for registries, MAX 500 LoC per file and 100 per function, vp toolchain only.

## Brand Commitments

Product name "Spreissen" (wordmark "spreissen"), defined once in `src/lib/brand.ts` with the amber sprout mark and the voice guide in `docs/design/brand.md`: plain, short, warm, no hype. Each bot has its own generated character (`src/lib/avatar.ts`); entity names are product content, not chrome: Jev (decision faculty) and the owner's bots (e.g. Rook); a fresh install has none. The 2026-10-31 redesign (`docs/design/direction.md`) sets the current look: dark by default, soft rounded surfaces, one warm accent.

## Evidence on Hand

Working product with real data: live bots with transcripts, tool traces, tasks, rooms, skills, vault items, audit tails (owner's dev server on 5173/8787). The owner shared screenshots of reference interfaces with each redesign brief (2026-10-30, 2026-10-31); what was taken from them is written down in `docs/design/direction.md`. No marketing site, no testimonial or benchmark claims; none may be invented.

## Product Principles

1. The crew is the product: every surface presents entities (bots) and their state, never raw session plumbing.
2. Autonomy must be legible: what a bot is doing right now, what it spent, what it waits on — always one glance away, in chat, tasks, and the nav.
3. Trust through provenance: approvals, audit, memory proposals, and skill origins are first-class UI, never buried.
4. One owner, deep use: speed, keyboard-grade craft (Cmd/Ctrl-K, N, ?) and small moments of delight over marketing gloss; built to be stared at for hours in the dark.
5. Same substance on every width: phone and desktop are the same product at two densities, not two features sets.

## Accessibility & Inclusion

WCAG AA contrast on both themes; visible focus; form controls at 16px on phones (iOS zoom); transcript text sizes never below 12px rendered; all interactive elements keyboard-reachable; motion respects reduced-motion.

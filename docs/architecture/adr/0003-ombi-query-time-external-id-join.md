# ADR 0003: Ombi requests join library items at query time via external ids (no FK)

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect

## Context

Request rows must connect to `library_items` to power attribution on the Never Watched page
and wasted-storage stats. `library_items` rows are churned by library sync (items are
deleted/recreated with new `id`s on re-sync), so any hard reference to `library_items.id` is
unstable. Measured id coverage on the live data: 658/658 movies and 271/274 series carry at
least one external id (`imdbId`/`tmdbId`/`tvdbId`); `library_items` indexes the same three
ids partially (`schema.ts:1026-1033`), and `services/library/buildExternalIdMatchKey.ts`
already establishes the precedence imdb → tmdb → tvdb (→ normalized title). Scale: ~1k
request rows, tens of thousands of library items.

## Decision

Store `imdb_id`, `tmdb_id`, `tvdb_id` (denormalized from Ombi) plus `title`/`release_year`
on each `ombi_requests` row and **join to `library_items` at query time** on external ids
with imdb → tmdb → tvdb precedence. No foreign key to `library_items.id`. The normalized-
title fallback tier is deliberately excluded for attribution (wrong attribution is worse
than none; id coverage is 99.7% measured).

## Options considered

1. **Query-time external-id join (chosen)** — pros: survives library re-syncs and server
   re-adds unchanged; request rows are self-contained (render even when media leaves the
   library); zero maintenance coupling between the two sync jobs; cons: heavier join than a
   FK — trivial at ~1k rows against partial indexes on both sides.
2. **FK to `library_items.id`, re-linked on each sync** — pros: cheapest join; cons: every
   library sync orphans links (CASCADE loses attribution, SET NULL demands a re-link pass),
   creating an ordering dependency between two independent jobs; complexity spent to
   optimize a join that is not a bottleneck.
3. **Hybrid (nullable FK cache + id fallback)** — pros: fast path plus resilience; cons:
   two code paths and cache-invalidation rules for no measurable gain at this scale;
   over-engineering for a homelab tool.

## Consequences

- Positive: the Ombi mirror and the library sync stay fully decoupled; a request for media
  that was later deleted still counts in requester stats (correct: the storage question is
  answered by the join simply matching nothing).
- Negative / trade-offs: the 3/274 series without any external id can never surface on
  library views (they still appear in per-requester counts); items whose ids disagree across
  sources could theoretically double-match — implementations should pick-first by the stated
  precedence (LATERAL) for determinism.
- Follow-ups: if library size grows an order of magnitude, revisit with EXPLAIN before
  adding any caching; keep the join predicate identical to `buildExternalIdMatchKey`'s
  precedence so behavior stays explainable.

# ADR 0010: Per-user played-state mirror table with query-time OR-extension of never-watched

**Status:** Accepted
**Date:** 2026-07-29
**Deciders:** software-architect

## Context

Tracearr flags an item "never watched" when no session with `duration_ms >= 120000` matches
it (`routes/library/neverWatched.ts`, `routes/library/stale.ts`). Session history only starts
when Tracearr's polling began (2026-01-02 on the reference instance), so prior viewing is
invisible. Measured on production: 472 of 1,160 flagged items (41%) are contradicted by
Emby's own per-user played flags; 856 flagged items predate session coverage entirely.

Emby (and Jellyfin, same API family) exposes durable per-user played state via
`GET /Users/{userId}/Items?IsPlayed=true&IncludeItemTypes=Movie,Episode&Fields=UserData`.
Verified characteristics: item `Id` = `library_items.rating_key`; episodes carry `SeriesId`
= the show's `rating_key`; historical plays have `Played: true` but `PlayCount: 0` and
`LastPlayedDate: null` (the source answers _whether_, not _when_); `DateLastSaved` moves on
metadata refresh, so no trustworthy incremental cursor exists; a full sync is ~49 requests
and 18,381 rows total. Plex has no equivalent without per-user tokens.

The repo already has two relevant precedents: full-mirror resync with `synced_at`-driven
pruning (`media_requests`, ADR 0004) and no-FK query-time joins against the churning
`library_items` table (ADR 0003).

## Decision

1. **Store a per-user mirror table `played_states`** keyed by
   (`server_user_id`, `rating_key`) with denormalized `server_id`, `media_type`
   (`movie`/`episode`), `series_rating_key` (Emby `SeriesId`), best-effort `played_at`/
   `play_count`, and a run-stamped `synced_at`. No FK to `library_items` (ADR 0003
   reasoning); FKs to `servers` and `server_users` with CASCADE.
2. **Full-mirror sync semantics** (ADR 0004 pattern): every run upserts all rows for each
   user, then prunes that user's rows with stale `synced_at` — but only for users whose
   fetch succeeded. Idempotent and replayable; handles removed items and un-marked plays.
   Users removed from the media server keep their rows (their historical plays remain true);
   rows die only with the `server_users` row.
3. **Query-time OR-extension, no stored roll-up:** an item is watched if a qualifying
   session exists OR `EXISTS` a `played_states` row matching
   (`server_id`, `rating_key`) for movies or (`server_id`, `series_rating_key`) for shows.
   Supported by a unique index on (`server_user_id`, `rating_key`) plus secondary indexes on
   (`server_id`, `rating_key`) and partial (`server_id`, `series_rating_key`).
4. **Stale-endpoint semantics:** an item with a played flag but no dated session is excluded
   from `never_watched` AND from `stale` (its recency is unknowable; `daysStale` would be a
   fabrication). It leaves the stale endpoint until a dated source (ADR 0012) supplies real
   timestamps.

## Options considered

1. **Mirror table + query-time EXISTS (chosen)** — pros: proven pattern twice over in this
   repo; idempotent; per-user granularity kept (future features: per-user watched lists);
   two indexed probes over ~18k rows is negligible next to the existing sessions
   `NOT EXISTS`; Plex degrades to a no-op naturally. Cons: two extra EXISTS per analytics
   query; full 49-request sync every run (forced anyway by the unreliable cursor).
2. **Derived `watched_by_anyone` boolean on `library_items`** — pros: cheapest possible
   query. Cons: `library_items` churns on every library sync (the column would be wiped or
   need re-derivation on two independent job schedules); invalidation coupling between two
   sync jobs is exactly what ADR 0003 was written to avoid; loses per-user granularity.
3. **Synthesize `sessions` rows from played flags** — pros: zero query changes. Cons:
   fabricates timestamps/durations the source explicitly does not have, poisoning every
   dated metric (stale days, watch counts, ROI, history); irreversibly mixes evidence
   grades in one table. Rejected on honesty grounds.
4. **Roll-up table keyed (server_id, rating_key) "watched by anyone"** — pros: single-probe
   join. Cons: loses the per-user dimension for marginal gain at this scale; still needs the
   same mirror sync underneath; premature optimization.

## Consequences

- Positive: the 472 false flags clear on first sync; the fix is source-of-truth-driven and
  self-healing (mirror), not a one-off backfill; `neverWatched.ts` and `stale.ts` keep
  returning consistent sets because both consume the same predicate.
- Negative / trade-offs: played-flag-only items vanish from the stale endpoint entirely
  (documented, deliberate — they return with real dates once ADR 0012's ingest runs);
  `played_at`/`play_count` columns are display-grade only and must never be filtered on;
  Jellyfin path is inferred from the shared API family and **must be verified against a
  Jellyfin instance or fixture during build** before enabling.
- Follow-ups: revisit a stored roll-up only if EXPLAIN shows the EXISTS probes matter at
  10× scale; per-user watched-list features can build on this table unchanged.

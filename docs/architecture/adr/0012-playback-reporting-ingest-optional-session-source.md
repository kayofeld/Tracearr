# ADR 0012: Playback Reporting ingest as a decoupled, opt-in second session source

**Status:** Accepted (design); build deferred to increment 2
**Date:** 2026-07-29
**Deciders:** software-architect

## Context

Played-state sync (ADR 0010) answers _whether_ an item was watched but never _when_ or _how
long_. The Emby **Playback Reporting** plugin holds timestamped, duration-bearing playback
rows (`POST /user_usage_stats/submit_custom_query`; 6,884 rows / 91 days on the reference
instance, retention now "forever"). Ingesting them as `sessions` rows would backfill the
pre-polling history gap and let every dated metric (stale days, watch counts, ROI, patterns)
improve with no query changes. But the plugin is optional, Emby-only, and its rows overlap
with sessions Tracearr already polled — double counting is the primary hazard. The repo
already imports external session history twice (Tautulli, Jellystat) through
`services/import/` with a shared dedup module and `sessions_dedup_fallback_idx`.

Note: no Playback Reporting client code exists in the repo today (zero grep hits for
`user_usage_stats`) — this is a new integration, not an extension of an existing one.

## Decision

Build the ingest as a **separate, opt-in component**, fully decoupled from played-state sync:

- **Opt-in:** settings key `playbackReportingEnabled` (boolean, default `false`). The
  played-state sync never touches the plugin; the ingest never touches `played_states`.
  A 404 from the plugin endpoint is surfaced as "plugin not installed", never treated as an
  empty result.
- **Rows become ordinary `sessions` rows** (the Tautulli/Jellystat precedent), with
  `externalSessionId = 'pbrep:' + rowid`, `state = 'stopped'`, `startedAt = DateCreated`,
  `durationMs = PlayDuration * 1000`, user resolved via `server_users.external_id`.
- **Two-tier dedup** via the existing `services/import/deduplication.ts`:
  (1) exact `externalSessionId` match — re-run idempotency;
  (2) time-key fallback — skip when any existing session (any source, including polled)
  matches (`serverId`, `serverUserId`, `ratingKey`) with `startedAt` within ±120 s.
- **Stateless incremental cursor:** each run ingests rows newer than
  `max(started_at) of existing 'pbrep:%' sessions minus a 1-day overlap margin`; dedup
  absorbs the overlap. No Redis cursor to drift or lose.
- **Job posture:** own BullMQ queue `playback-reporting-ingest`, 6-hourly when enabled; the
  initial historical run acquires `heavyOpsLock` as jobType `'import'` (it is an import in
  all but delivery mechanism); incremental runs are light and lock-free.

## Options considered

1. **Separate opt-in ingest into `sessions` (chosen)** — pros: dated rows flow through every
   existing metric for free; reuses the proven import/dedup machinery; the two corrections
   (whether vs when) fail independently; disabling it stops ingestion without touching
   played-state correctness. Cons: two jobs to operate; a second source of `sessions` rows
   to reason about (mitigated by the `pbrep:` prefix convention).
2. **Fold ingest into the played-state sync job** — pros: one job. Cons: couples a
   must-work correctness fix to an optional plugin's availability; a plugin failure would
   taint played-state runs; violates the brief's hard decoupling constraint.
3. **Distinct table for reporting rows (not `sessions`)** — pros: clean provenance. Cons:
   every dated metric would need a second UNION source — the entire value of the ingest is
   that existing queries need no changes; provenance is already carried by the
   `externalSessionId` prefix, same as Tautulli/Jellystat imports.
4. **One-shot manual import (file-style, like Jellystat backup)** — pros: simplest. Cons:
   the plugin keeps accumulating rows (retention set to forever); a recurring incremental
   ingest keeps the gap closed permanently instead of once.

## Consequences

- Positive: ~23 additional never-watched corrections immediately (estimated from the probe)
  and growing coverage of _dated_ history from here on; ADR 0010's excluded
  "played-but-undated" items progressively re-enter the stale endpoint with honest
  `daysStale`; zero analytics query changes.
- Negative / trade-offs: rows lack IPs (the NOT NULL `sessions.ip_address` needs the import
  sentinel convention — explicit backend decision at build time); geo/device analytics gain
  nothing from ingested rows; Emby-only (the plugin does not exist for Jellyfin/Plex);
  duration semantics of `PlayDuration` should be validated against a known play during
  build before trusting the ×1000 conversion (**inferred — unverified**: field observed in
  the probe, unit not cross-checked against a controlled play).
- Follow-ups: when increment 2 is planned, freeze its endpoint/type contract (status +
  enable/disable + trigger) the same way §7–8 of the design doc froze increment 1's; decide
  the IP sentinel with the data-engineer; consider a Jellyfin equivalent only if a
  comparable plugin exists there.

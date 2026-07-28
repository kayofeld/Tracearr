# ADR 0007: Seerr request titles are derived at query time, not fetched or stored (v1)

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect

## Context

Seerr's request payload carries **no title** (probe-verified over all 108 requests: `media`
holds ids — `tmdbId` 108/108, `tvdbId` 43, `imdbId` 56 — but no title field). Ombi supplied
titles, and `ombi_requests.title` was made NOT NULL for resilience ("a request renders even
when unmatched"). The Seerr rows cannot honor that constraint without extra fetches.

Measured consumption reality: **no endpoint reads the stored request title today**
(grep-counted: the only references to `title` in the Ombi feature are the sync write path in
`services/ombi.ts`, its tests, and the upsert in `jobs/ombiSyncQueue.ts`). The stale
attribution fragment and the requester-stats page take titles from `library_items`; the
mapping UI shows usernames; there is no per-request list endpoint.

Seerr does expose media-detail endpoints (`GET /api/v1/movie/{tmdbId}`,
`GET /api/v1/tv/{tmdbId}` in the Overseerr lineage — keyed by TMDB id, present on 108/108
requests) that return titles, at the cost of one HTTP call per request row.

## Decision

For seerr rows, `media_requests.title` is **NULL in v1** (column made nullable in migration
0068; Ombi rows keep their titles). Any surface that displays a request title uses the
fallback chain, specified in the design and binding on future consumers:

```
title  ??  matched library_items.title (query-time external-id join, ADR 0003)  ??  "TMDB #<tmdbId>"
```

No blank column is silently shipped: the chain is the documented display contract, and the
`"TMDB #<id>"` terminal is an explicit, honest placeholder for the (rare) unmatched case —
predominantly pending/declined requests whose media never entered the library.

Sanctioned upgrade path, to be triggered by the first real consumer (e.g. a per-request list
UI): **sync-time hydration** — after the mirror upsert, fetch titles via the media-detail
endpoints for rows `WHERE source='seerr' AND title IS NULL` only (titles are immutable once
set), with per-row failure degrading to the query-time chain. Backlog cost at adoption time:
one call per unhydrated row (108 today), then a trickle of new requests per sync. The exact
endpoint shapes must be verified at build time before relying on them (not covered by the
coordinator's probe).

## Options considered

1. **Query-time derivation, NULL stored title (chosen)** — pros: zero extra API calls, no
   second fetch path, proportionate to a column nothing reads; the library join already
   exists and covers the overwhelming case (most requests are status=available, i.e. in the
   library); cons: unmatched requests display an id placeholder — acceptable because no
   surface renders request titles today and the placeholder is honest.
2. **Sync-time hydration from Seerr media endpoints** — pros: real titles stored, unmatched
   requests render nicely; cons: ~108 extra calls on first sync plus a per-new-request call
   forever, a second Zod surface, and failure/retry handling — all for a column with zero
   consumers (grep-verified). Kept as the documented upgrade path, not built speculatively.
3. **No title anywhere, always render ids** — pros: simplest; cons: gratuitously worse
   display than the free library-join title; rejected.
4. **Make title NOT NULL and refuse unhydrated rows** — cons: couples request mirroring to a
   metadata fetch (a Seerr metadata hiccup would drop attribution rows); violates
   "attribution outranks decoration"; rejected outright.

## Consequences

- Positive: v1 ships with no new fetch surface; the display contract is explicit; the
  hydration path is designed and cheap to adopt when a consumer appears.
- Negative / trade-offs: `title` is now nullable for all sources at the schema level (Ombi
  writes remain NOT NULL in practice); a future per-request UI must implement the fallback
  chain or trigger hydration first.
- Follow-ups: when hydration is built, verify the media-detail endpoint shapes against the
  live instance; keep hydrated titles immutable (no re-fetch churn in the 6h mirror).

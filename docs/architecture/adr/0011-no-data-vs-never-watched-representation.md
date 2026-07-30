# ADR 0011: "No data" vs "never watched" — server-level coverage in the response, page-level banner

**Status:** Accepted
**Date:** 2026-07-29
**Deciders:** software-architect

## Context

Even with played-state sync (ADR 0010), Tracearr can be honestly ignorant: Plex servers
expose no per-user played state without per-user tokens, and an Emby/Jellyfin server whose
sync has never completed has no coverage yet. Today the UI asserts "never watched" in both
cases, which is a claim the data cannot support — on the reference instance, 856 of the
flagged items predate all session coverage. Tracearr is multi-server: a single response can
mix covered (Emby, synced) and uncovered (Plex) servers, so "does this instance have
coverage" is not a yes/no — it is per server.

Three candidate representations were on the table: a per-server coverage flag surfaced in
the response, a distinct per-item state ("no data" vs "never watched"), or a purely
client-side page-level banner.

## Decision

**Surface a server-level coverage object in both analytics responses, and render one
page-level banner from it.** Concretely:

- `NeverWatchedStatsResponse` and `StaleResponse` gain optional
  `playedStateCoverage: PlayedStateCoverage` —
  `{ servers: [{ serverId, serverName, capability: 'supported'|'unsupported', lastSyncedAt }], full: boolean }`.
- Coverage truth lives in Postgres (`played_state_sync_status`, one row per server), not
  Redis, so honesty survives restarts and cache flushes. `capability` is derived from the
  server type (`plex` → `unsupported`, v1 rule); `lastSyncedAt` from the last
  success/partial run.
- The web UI shows a single page-level banner when `full === false`, naming the uncovered
  servers, and switches page copy from "Never watched" to "No recorded plays" whenever any
  in-scope server is uncovered. No banner when coverage is full or the field is absent
  (stale cache tolerance window).

## Options considered

1. **Server-level coverage in the response + page banner (chosen)** — pros: coverage IS a
   server-level fact (a Plex server's ignorance applies uniformly to all its items), so the
   representation matches the truth's actual granularity; one field, additive and optional,
   no change to item shapes or pagination; the API stays self-describing (mobile app and API
   consumers get the same honesty, not just the web UI). Cons: an item-level distinction
   ("this specific item is unknowable") is not expressible — accepted, because no item-level
   evidence exists that the server-level fact doesn't already imply.
2. **Distinct per-item state (`no_data` category or per-item flag)** — pros: maximally
   explicit per row. Cons: implies per-item certainty that does not exist (every item on an
   uncovered server is uniformly unknowable — the flag would be a constant per server,
   bloating 50-row pages with repeated data); forces a breaking change to the frozen
   `StaleCategory`/`StaleItem` wire shapes and every consumer's filter/summary logic;
   splits summary counts into a third bucket the product has no page for.
3. **Client-side banner only (UI infers from server list)** — pros: zero API change. Cons:
   the client cannot know sync state (never-run vs synced) without a coverage source anyway;
   duplicates capability rules into web AND mobile; the API keeps lying to non-UI consumers.

## Consequences

- Positive: honest by construction for Plex-only and never-synced instances with zero
  behavior change to their numbers; additive optional field keeps cached pre-deploy payloads
  valid during one TTL; the same object powers the settings status card.
- Negative / trade-offs: counts on mixed fleets still include uncovered servers' items in
  "never watched" — the banner contextualizes rather than re-buckets them (re-bucketing is
  option 2, rejected); UI copy discipline ("No recorded plays") is a convention the
  design/frontend must hold, not something the API can enforce.
- Follow-ups: if Plex per-user tokens ever land, only the capability derivation changes —
  the representation already accommodates per-server variance.

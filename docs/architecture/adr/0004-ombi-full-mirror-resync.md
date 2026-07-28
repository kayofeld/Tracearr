# ADR 0004: Ombi sync is a full-mirror resync (fetch all, upsert, prune) — not incremental

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect

## Context

The connector needs current request state (status transitions, deletions, new requests).
Verified against the live Ombi 4.47.1: `GET /api/v1/Request/movie` (658 records, ~1.5 MB) and
`GET /api/v1/Request/tv` (274 parents, ~3.4 MB) are **unpaged** — the paged variants 404 to
the SPA — and Ombi exposes no change feed or since-parameter usable here. Total volume is
~950–1,100 attributable rows (estimated; movies counted 658, TV children ≥274), growing by a
few hundred per year. Requests are also mutable (approved/denied/available flips) and
deletable in Ombi.

## Decision

Every sync run fetches both endpoints in full and treats the result as the truth:

- **Upsert** on `UNIQUE (media_type, ombi_request_id)`, stamping `synced_at` with the run's
  start timestamp.
- **Prune** rows whose `synced_at` predates the run, per media type, in the same
  transaction as that type's upserts — and only when that type's fetch succeeded with zero
  per-record validation failures (a skipped-but-present record must not flap).
- Movies and TV are independent phases/transactions: a TV failure leaves the completed movie
  phase intact and the status endpoint reports the split.
- Cadence: repeatable job every 6 hours plus a manual owner trigger.

## Options considered

1. **Full mirror + prune (chosen)** — pros: trivially idempotent (safe under BullMQ
   retries); status flips and deletions handled for free; no watermark state to corrupt;
   the full fetch is unavoidable anyway (unpaged API); cons: rewrites ~1k rows per run —
   negligible (seconds, single-digit MB).
2. **Incremental by `requestedDate` watermark** — pros: smaller writes; cons: the fetch is
   still full-payload (no server-side filter), misses status mutations and deletions
   entirely, adds watermark bookkeeping — cost without benefit.
3. **Event-driven (Ombi webhooks)** — pros: near-real-time; cons: Ombi's webhook coverage
   is notification-oriented and unverified for this instance, requires inbound
   reachability/config on the Ombi side, and still needs a reconciliation sync for missed
   events; disproportionate for a 6-hourly freshness need.

## Consequences

- Positive: sync correctness reduces to "the last successful run's snapshot"; retries and
  overlapping manual triggers are harmless; deleted Ombi requests disappear from Tracearr
  within one cycle.
- Negative / trade-offs: up to 6h staleness (manual trigger covers impatience); prune means
  Tracearr keeps **no history beyond Ombi's own** — if the owner mass-deletes requests in
  Ombi, attribution disappears here too (documented; an archival mode is deliberately not
  built).
- Follow-ups: the validation-failure prune guard must be tested explicitly (skip ≠ delete);
  if Ombi ever ships working pagination + delta params, revisit — until then this is the
  simplest correct design.

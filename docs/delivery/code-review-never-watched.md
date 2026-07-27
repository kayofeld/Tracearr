# Code review — "Never Watched" increment (feat/never-watched-page)

Reviewer: `code-reviewer` (independent, read-only) · 2026-07-27 · Diff: b321adfa + 630cbfa2 + be158b61 vs main
Verdict: **NO-GO (conditional)** — CR-1/CR-2 must be fixed before merge; CR-3/CR-4 recommended same pass.
Fix round dispatched 2026-07-27 (backend + frontend engineers); re-verify follows.

## Findings

| ID   | Sev  | Finding                                                                                                                                                             | Location                                                          | Resolution                                                                                                                        |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| CR-1 | High | "All" filter: stats endpoint scopes movies+shows, paired table (stale endpoint) also includes `artist` — contradictory numbers, worst case false global empty state | NeverWatched.tsx:103-113, neverWatched.ts:140/163 vs stale.ts:253 | FIX: additive optional `mediaTypes` param on stale (schema+SQL+cache key); page passes ['movie','show']                           |
| CR-2 | High | Filtered empty state early-returns without the Tabs — dead end + false "everything watched" copy when only the active filter is empty                               | NeverWatched.tsx:250-262                                          | FIX: global empty only when filter==='all'; filtered zero keeps layout; test added                                                |
| CR-3 | Med  | `byLibrary[].libraryName` is the SERVER name (no library-name source in DB); multi-library servers render duplicate labels                                          | neverWatched.ts:151; UI :152-157/:360                             | FIX: return library_id as key, UI labels truthfully, drop table Library column. BACKLOG: persist library names during librarySync |
| CR-4 | Med  | `oldestAddedAt` is pg `::text` format, not ISO (contract says ISO); Safari `new Date()` risk                                                                        | neverWatched.ts:224                                               | FIX: to_char ISO-8601 UTC; fixtures updated                                                                                       |
| CR-5 | Low  | `libraryId` z.string() vs stale's z.uuid() divergence (new schema is the correct one — column is varchar section key)                                               | schemas.ts:1086 vs :1071                                          | Comment documenting divergence; BACKLOG: align stale                                                                              |
| CR-6 | Low  | Page number not reset on server-selection change → out-of-range empty page                                                                                          | NeverWatched.tsx:82-84                                            | FIX: server-ids key in reset effect                                                                                               |
| CR-7 | Low  | Chart tooltip bucket match via String(this.x) label compare — fragile; sizeBytes mapped but unshown                                                                 | NeverWatchedAgeChart.tsx:117-122                                  | FIX: point.category pattern (DayOfWeekChart) + size in tooltip                                                                    |

## Verified clean (six critical checks)

Cache-key variant covers all result-shaping params; pctOfLibrary numerator+denominator both movie+show scoped;
sessions join scoped by server_id AND rating_key (episode subquery too); empty-access returns full zero-filled
shape; web queryKeys complete; category=never_watched + pagination totals correct. Show-rollup NOT EXISTS
consistent with stale.ts semantics (120000ms threshold both).

## Backlog notes (not defects of this increment)

- Persist library display names during librarySync (small `libraries` table or name-on-item) — makes byLibrary/Library labels human. (data-engineer migration)
- Align `libraryStaleQuerySchema.libraryId` to `z.string().max(100)` — current z.uuid() would 400 on real Plex section keys the moment a library filter UI exists.
- stale.ts `addedAt` has the same non-ISO `::text` latent pattern (pre-existing).
- Synthetic added-at fallback dates (Jan-1-of-year) inflate the gt365 bucket and "Oldest Item" — consider flagging once persisted metadata allows.

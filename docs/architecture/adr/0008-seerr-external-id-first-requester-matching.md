# ADR 0008: Seerr requester matching is external-id-first, with the external id persisted

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect (coordinator pre-work: cross-database matching measurements)

## Context

ADR 0002 defined the Ombi resolution pipeline (manual → provider id → username →
unattributed) around a weak-identity reality: Ombi local accounts with empty
`providerUserId`, forcing username matching (30/33 measured) with the provider tier as a
zero-match future-proof. Ombi's `providerUserId` is deliberately **transient** — read at sync
time, never persisted — which means Ombi's immediate re-resolution path (mapping PUT/DELETE)
must skip the provider tier and fall back to username.

Seerr is the opposite reality, measured: `requestedBy.jellyfinUserId` is present on
**108/108** requests, and the 16 distinct values match `server_users.external_id` **16/16**
on the dev database (and 0/16 on production, which fronts a different media server —
expected, and exactly the behavior wanted: a strong id matches only where it should).
Usernames also match 16/16 there, but a username is mutable and collision-prone where a
media-server user GUID is neither. On Plex-backed Seerr instances the analogous field is
`plexId` (null on all 108 here) matching `server_users.plex_account_id`.

## Decision

Keep ADR 0002's pipeline shape and vocabulary; promote the external-id tier to the primary
automatic tier and **persist the id** on each request row
(`media_requests.source_external_user_id`, null for ombi rows):

1. **Manual override** (`media_request_user_mappings`, source='seerr') — `user_id` or
   force-unattributed. `match_method='manual'`.
2. **External id**: `jellyfinUserId` → `server_users.external_id`; if null, `plexId` →
   `server_users.plex_account_id`; resolve to that server_user's `user_id`. If candidates
   resolve to more than one distinct `user_id`, refuse and flag ambiguous (never guess).
   `match_method='provider'` (existing vocabulary reused — no enum widening).
3. **Case-insensitive username**: `lower(source_username)` vs `lower(users.username)`;
   ambiguity → refuse and flag. `match_method='username'`.
4. **Unattributed**: `user_id=null`; raw identity retained; surfaces in the mapping UI and
   the explicit unattributed stats bucket.

Recomputed every sync. Because the external id is persisted, mapping-change re-resolution
runs the **full** pipeline offline — no live Seerr payload needed — unlike Ombi's
username-only fallback.

PII boundary (consistent with the Ombi design §7): `jellyfinUserId` is an opaque media-server
GUID of the same sensitivity class as the already-stored `server_users.external_id`; storing
it is minimization-compatible. `email` (present 108/108) is **not stored** — it adds zero
matching value over a 16/16 external-id tier and is strictly higher-sensitivity.

## Options considered

1. **External-id-first with persistence (chosen)** — pros: 16/16 automatic attribution with
   the strongest available identity; immune to renames and username collisions; correct
   cross-instance behavior (0/16 on the wrong server); offline re-resolution at full
   strength; expected manual-mapping volume ~0. Cons: one more persisted identifier —
   justified by its sensitivity class and by being the primary match key, not a convenience.
2. **Transient external id (mirror Ombi's providerUserId handling)** — pros: symmetric with
   ADR 0002, one less column. Cons: the asymmetry is principled, not accidental — for Ombi
   the provider tier matches zero rows, so losing it offline costs nothing; for Seerr it is
   the primary tier, and degrading mapping-change re-resolution to username-only would make
   the owner's one management action weaker than the automatic sync. Rejected.
3. **Username-first (treat Seerr like Ombi)** — pros: no new column, matches 16/16 today.
   Cons: discards a measured-perfect stable identifier in favor of a mutable one; renames
   silently re-route attribution; contradicts "wrong attribution is worse than missing."
4. **Email matching** — rejected for the same minimization reasons as ADR 0002; the
   transient-in-memory escape hatch noted there remains available and remains unneeded.

## Consequences

- Positive: every Seerr request attributes automatically today; the pipeline degrades
  gracefully on Plex-backed instances via `plexId`; `match_method` vocabulary and the
  mappings/stats contracts carry over unchanged.
- Negative / trade-offs: `source_external_user_id` is dead weight on ombi rows (null by
  design); a media-server migration (new Jellyfin instance = new user GUIDs) drops tier 2 to
  the username tier until server_users re-syncs — self-healing, and the status endpoint's
  attribution breakdown makes it visible.
- Follow-ups: build-time check that Seerr `plexId` values are plex.tv account ids (matching
  `plex_account_id`, not the local PMS `external_id`) before enabling the Plex sub-tier;
  QA covers the ambiguity-refusal path with two server_users sharing an external id mapped
  to different users.

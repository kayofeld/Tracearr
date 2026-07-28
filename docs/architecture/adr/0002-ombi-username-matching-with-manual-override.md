# ADR 0002: Ombi requester attribution by case-insensitive username with manual override

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect (coordinator pre-work: live-probe evidence)

## Context

The Ombi connector must attribute requests to Tracearr identities (`users.id`). Measured on
the live instance (Ombi 4.47.1): all 33 distinct requesters are Ombi **local** accounts
(`userType=1`) with an **empty `providerUserId`** and no email on 32/33. There is no strong
shared identifier between Ombi and Tracearr. Case-insensitive username comparison resolves
30/33 requesters against both `server_users.username` and `users.username`; the remaining 3
(`Azel`, `Neopier`, `Tiwoof`) have no automatic path. Requests must never be lost or
misattributed: a wrong attribution is worse than a missing one.

## Decision

Resolve at sync time through a strict pipeline, first hit wins, recording the method:

1. **Manual override** from `ombi_user_mappings` (owner-set; `user_id = null` means
   force-unattributed).
2. **Provider id**: Ombi `providerUserId` → `server_users.plex_account_id` (zero matches
   today; correct for standard Ombi+Plex setups, costs one condition).
3. **Case-insensitive username**: `lower(ombi_username) = lower(users.username)`; if more
   than one user matches, refuse and mark ambiguous (never guess).
4. **Unattributed**: `user_id = null`; the raw Ombi identity (`ombi_user_id`,
   `ombi_username`, `ombi_alias`) stays on the row, surfaces in the mapping UI and in an
   explicit "unattributed" stats bucket.

Resolution is recomputed every sync; a mapping change immediately re-resolves that
requester's rows. Aliases are display hints only, never a match key.

## Options considered

1. **Username match + manual override (chosen)** — pros: covers 30/33 automatically today,
   deterministic, self-heals as users appear/rename, stragglers fixable in one owner action;
   cons: usernames are a weak identity, drift possible (mitigated by per-sync recompute,
   ambiguity refusal, and the override).
2. **Manual mapping only** — pros: zero false positives; cons: 33 hand-mappings up front and
   every new requester needs owner action; disproportionate when 91% auto-match cleanly.
3. **Email matching** — pros: strong where present; cons: present on 1/33 (measured), and it
   would push storing email (rejected on minimization — see the PII section of the design).
   Sanctioned escape hatch if ever needed: transient in-memory email comparison at sync time
   without persisting the email.
4. **Fuzzy/alias matching** — pros: might catch the 3 stragglers; cons: aliases are free
   text; false attribution risk violates the "wrong is worse than missing" constraint.

## Consequences

- Positive: 30/33 attributed with zero configuration; nothing is ever lost (raw identity on
  every row); the unattributed bucket keeps stats honest; provider tier future-proofs
  Plex-OAuth Ombi setups.
- Negative / trade-offs: a renamed Tracearr user silently changes attribution at next sync
  (acceptable: recompute is the feature); member-role username collisions force manual
  resolution (by design — `users_login_username_unique` only covers owner/admin/viewer).
- Follow-ups: mapping UI must surface ambiguous and unattributed requesters prominently;
  watch whether real-world drift ever justifies notifying the owner when auto-attribution
  changes.

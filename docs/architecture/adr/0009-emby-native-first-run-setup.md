# ADR 0009: Emby-native first-run setup via a dedicated bootstrap endpoint

**Status:** Proposed, revision 2 (revision 1 was returned NO-GO by security review)
**Date:** 2026-07-29
**Deciders:** software-architect (design); repo owner (six open decisions listed below)
**Inputs:** `docs/delivery/security-review-emby-setup.md`
**Detail:** `docs/architecture/emby-native-setup.md`

## Context

The owner wants the very first user of a fresh Tracearr instance to establish their Emby server and
create the owner account with their Emby credentials ("put in the emby api token before signup ... so
using the emby password"), instead of inventing a separate local password.

This collides with a deliberate invariant in `apps/server/src/lib/embyPlugin.ts`: the Emby server URL
is never taken from the client, because accepting one would let an attacker point login at their own
Emby (where they are trivially admin), pass the isAdmin gate, and get bound as the Tracearr owner,
plus drive SSRF. The same file fails closed when no owner exists.

Revision 1 answered that the invariant protects an *existing* owner and that at first run there is
none to hijack. Security review showed the argument equivocates on "first run". The code's notion of
first run is "no `role='owner'` row", and an instance can be ownerless while still holding the
previous operator's servers, users and tokens: a support intervention, a partial restore, or the
better-auth admin plugin's user-removal surface all produce that state. Claiming such an instance is
takeover, not bootstrap, and the existing owner-only `pg_dump` backup export then hands over the
plaintext `servers.token` and Plex tokens. Three further stated controls also failed on inspection:
resolution of the configured Emby server is nondeterministic with two rows, the SSRF check is a
literal-only defense-in-depth function that follows redirects and never resolves hostnames, and the
single-owner index was placed in a best-effort startup path whose only caller swallows failures.

Constraints unchanged: Fastify, better-auth 1.6.23, Drizzle, React 19; reuse existing blocks; one
increment with backend and frontend in parallel. Open findings supplied with the original brief:
SR-02 (no DB constraint prevents two concurrent signups both becoming owner) and SR-03 (a fresh
internet-reachable instance is claimable because the claim code is opt-in).

## Decision

1. **A dedicated, unclaimed-only bootstrap endpoint** `POST /emby/setup` (new better-auth plugin
   `embySetupPlugin.ts`), the only place in the system that ever accepts a client-supplied Emby URL.

2. **The gate is instance state, not the absence of an owner row.** A new
   `getInstanceClaimState()` returns `unclaimed` (no `users`, no `auth_accounts`, no `servers` rows),
   `ownerless-with-data`, or `owned`. A client URL is accepted only in `unclaimed`. In `owned` the
   endpoint returns 403 before parsing the body and performs no outbound request, permanently. In
   `ownerless-with-data` it ignores the submitted URL, resolves the server URL server-side exactly as
   `/emby/login` does, requires the claim code unconditionally, and refuses outright when no claim
   code is configured or no server can be resolved. That state is logged at error level with a
   greppable marker at startup, hourly while it persists, and on every refusal.

3. **Server resolution becomes deterministic and fails closed.** `resolveConfiguredEmbyServerUrl()`
   orders explicitly and selects two rows; more than one `emby` row makes `/emby/login` fail closed
   rather than pick an arbitrary authentication authority. Setup never inserts a second `emby` row: in
   the recovery state it adopts the existing one. Whether multi-Emby is supported is a product
   question, so both database designs are specified (a partial unique index on `servers` for
   single-Emby, or an explicit `is_auth_authority` flag for multi-Emby) and the build takes whichever
   the owner picks. This is the one behavioral change to `embyPlugin.ts`; its NOTE and no-owner branch
   are otherwise untouched.

4. **Outbound probes go through a new `safeProbe` module, not through the shared `fetchJson`.** It
   canonicalizes the URL and rejects userinfo, query and fragment; applies a widened address deny list
   (metadata addresses, `0.0.0.0/8`, multicast, broadcast, and the IPv4-mapped forms of all of them)
   to literals *and* to every DNS-resolved address; sets `redirect: 'manual'` and treats any 3xx as a
   hard failure; re-validates the address at connect time; and never lets an upstream status, status
   text or body reach the client. Loopback, RFC1918 and CGNAT stay allowed, because blocking them
   would break the self-hosted audience. `fetchJson` is left alone because five integrations share it;
   the Emby client takes an injectable fetcher and only the setup path passes the hardened one.

5. **SR-02 is closed by a constraint that cannot be silently skipped.** `users_single_owner` moves out
   of `createPartialIndexes()` (whose caller downgrades failures to a warning and skips every later
   statement) into a drizzle migration, which aborts startup on failure. The statement is
   `CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner'`, replacing revision
   1's unverified `((true))` form. The migration opens with a guard that raises an actionable
   exception on a pre-existing duplicate-owner database rather than a raw index error, and startup
   asserts the index exists in `pg_indexes` afterwards. Revision 1 chose to degrade and continue on a
   duplicate-owner instance; that is the wrong trade for an auth-integrity constraint and is
   reversed.

6. **The funnel is the database, not the `user.create` hook.** Two Plex paths insert owner rows
   directly with drizzle, so the hook never runs for them. The index still holds, but this increment
   also maps the unique violation to 403 at both Plex sites and reorders `/plex/connect` so the
   contended user insert precedes the server write, otherwise the "SR-02 closed globally" claim ships
   with new 500s and a new orphan row.

7. **Atomicity by compensation, not a raw transaction.** `createUser` first because it is the
   index-guarded contended step, then the server row, the Emby link and the session; any later failure
   deletes what this attempt created (never an adopted row) so a failed setup leaves the instance
   retryable. Revision 1's duplicate-URL 409 is removed: a leftover server row now puts the instance
   in the recovery state, which adopts it. Compensation failures log
   `INSTANCE REQUIRES MANUAL RECOVERY` and name the real tools.

8. **Recovery is made real.** `pnpm reset-password` requires an existing owner row and the CLI has no
   way to promote a user, so refusing to let anyone claim an ownerless-with-data instance would be a
   brick rather than a recovery. This increment adds a console-only `promote-owner <username>` CLI
   command.

9. **Bounds are constants.** A `customRules` entry for the setup path (5 per minute per IP), an
   in-process cap of 2 concurrent setup probes, a 5 s per-probe timeout and a 15 s total outbound
   budget per request. None is derived from the request.

10. **Two credentials, each for its job** (unchanged from revision 1 and endorsed): the admin API key
    is verified with `verifyServerAdmin` and becomes `servers.token`; the Emby username and password
    are verified with `EmbyClient.authenticate`, must be admin, and bind the owner's Emby identity in
    `auth_accounts`, the same bind `/emby/login` performs, so subsequent logins need no new state. An
    API key alone has no user identity to bind; a password alone would make a revocable user token the
    polling credential.

Contract additions are additive: `EMBY_SETUP_PATH`, `EmbySetupResult` and (new in revision 2)
`EmbySetupErrorCode` in `@tracearr/shared` with barrel exports. The error-code union exists because
the client must render its own copy rather than server prose, which is what keeps upstream status text
out of responses. Request zod stays plugin-local; no socket events; no `SetupStatus` change.

## Options considered

1. **Dedicated bootstrap endpoint gated on instance state (chosen).** Keeps `embyPlugin.ts`'s
   credentials-only property verifiable at a glance, makes post-setup closure one gate at the top of
   one handler, and reuses every existing block. Cost: one more endpoint, one more path constant, and
   a state predicate that every claim path arguably should adopt.
2. **Extend `/emby/login` with an optional URL honored only when ownerless.** One endpoint, but it
   puts a client URL parameter on exactly the endpoint whose documented invariant is "never a client
   URL". A future refactor of the mode check silently reopens the bypass. Rejected, and the review
   endorsed the rejection.
3. **Raw drizzle transaction creating user, server and link atomically.** True atomicity, but it
   bypasses the better-auth hook chain (forced owner role, username normalization and uniqueness, the
   defense-in-depth signup gate) and duplicates its logic, creating drift with every other signup
   path. Rejected in favor of the established compensation pattern.
4. **Gate on "no owner row" (revision 1).** Simple and matched the existing helper, but it treats an
   ownerless-but-populated instance as fresh, which turns a bootstrap into a takeover with credential
   disclosure through the backup export. Rejected on review.
5. **Keep `assertSafeProbeUrl` as the primary SSRF control (revision 1).** Zero new code, but the
   function is literal-only, follows redirects through `fetchJson`, and says in its own comment that
   it is defense-in-depth. Rejected on review.
6. **Harden `fetchJson` globally instead of adding `safeProbe`.** Fixes the whole class at once, but
   changes redirect behavior for five integrations in an increment that cannot test them all.
   Rejected for now and tracked as a follow-up, coupled to owner decision 5.
7. **Token-only setup.** Emby API keys carry no user identity, so nothing binds in `auth_accounts` and
   `/emby/login` could never match a returning owner. Contradicts the owner's request. Rejected.
8. **Password-only setup, deriving the server token from the user's access token.** User access tokens
   are revocable in ways dedicated API keys are not (inferred, unverified; verifiable against a live
   Emby), which makes the polling credential fragile, and it diverges from `POST /servers`
   provisioning. Rejected.
9. **Status quo: local password signup, then link Emby.** No new attack surface, but it does not
   deliver the requested feature. Rejected as a non-answer, and it remains available in the UI as the
   parallel local-setup mode.

## Owner decisions this ADR does not take

1. Claim code default-on, whether an auto-generated code persists across restarts (the `settings`
   table is the obvious home, and `initializeClaimCode()` currently runs before the database is
   available), and whether it is single-use.
2. An in-app set-password surface in this increment, or accept CLI-only recovery and document it.
3. Is more than one Emby server a supported configuration? Design A and design B are both specified.
4. Accept or reject the residual SSRF exposure after mitigation. Loopback and RFC1918 stay allowed, so
   a pre-claim internal reachability oracle remains. The reviewer judges it acceptable provided the
   claim code is on by default, which links this to decision 1.
5. Route `/plex/connect`'s probes through `safeProbe` in this increment, or track it separately.
6. Architect-surfaced: should the unclaimed-state gate apply to `/sign-up/username` and OIDC
   first-signup as well? It closes the takeover path completely, and it also stops an operator
   recovering a restored backup through the browser.

## Consequences

- **Positive.** First-run UX matches the *arr and Jellystat expectation. SR-02 is closed globally by a
  constraint that fails loudly rather than silently. The URL invariant survives in a stronger,
  state-scoped form, and `/emby/login` now fails closed on an ambiguity it previously resolved by
  accident. Every subsequent Emby login works with no migration, because setup seeds the same bind.
  Two pre-existing defects outside this feature (the Plex race producing 500s and orphan rows, the
  missing promote-owner recovery command) are fixed on the way through.
- **Negative and accepted.** The owner has no local password, so an Emby outage locks them out unless
  OIDC is configured or the console is reachable; there is no in-app set-password surface today, which
  revision 1 wrongly assumed there was. While genuinely unclaimed, the instance still exposes a
  bounded internal reachability oracle to whoever can reach it, narrowed to claim-code holders when
  the code is enabled. On Alibaba Cloud specifically, the metadata address sits inside the CGNAT range
  the product must keep allowed. Recovery from a failed compensation requires a claim code to be
  configured. Plaintext `servers.token` storage is inherited unchanged.
- **Follow-ups.** The six owner decisions above. Route every media-server probe through `safeProbe`.
  Verify the three inferred-unverified items named in the design's claim register (Emby token
  revocation semantics, undici's custom `connect.lookup`, better-auth's `customRules` spelling). Future
  Jellyfin and Plex setup parity should reuse this endpoint's three-verb shape rather than adding more
  bespoke paths.

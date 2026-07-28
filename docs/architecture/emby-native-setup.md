# Emby-Native First-Run Setup - Design

**Status:** Proposed, revision 2 (design only, no implementation)
**Date:** 2026-07-29
**Author:** software-architect
**Branch:** `feat/emby-native-setup` (worktree, based on v1.9.0)
**Companion ADR:** `docs/architecture/adr/0009-emby-native-first-run-setup.md`
**Supersedes:** revision 1, which a security review returned as NO-GO
(`docs/delivery/security-review-emby-setup.md`)

## 0. What changed in revision 2

Revision 1 was reviewed and rejected as written: 4 High, 4 Medium, 3 Low. The shape of the design
survived (separate endpoint, refined invariant, two credentials, compensation over a raw
transaction, SR-02 closed at the database). Four stated controls did not actually hold. This
revision resolves them and corrects four factual errors.

| Finding | Resolution | Section |
|---|---|---|
| SEC-01 the gate is "no owner row", not "fresh instance" | Three-state instance model; setup allowed only when *unclaimed*; a recovery state that refuses the client URL and demands a claim code | 3, 6 |
| SEC-02 a second `emby` row makes login nondeterministic | Deterministic, fail-closed resolution in `/emby/login`; setup never inserts a second row; two designs depending on owner decision 3 | 4 |
| SEC-03 SSRF control does not survive a deliberate attacker | New `safeProbe` module: manual redirects, hostname resolution, connect-time re-validation, widened deny list, no upstream status in client errors | 8 |
| SEC-04 the SR-02 index may silently never exist | Moved to a drizzle migration (aborts startup on failure), `(role)` form, plus a post-migration existence assertion | 7.1 |
| SEC-05 the `user.create` hook is not the funnel | Sentence corrected (the funnel is the database); violation mapped to 403 at both Plex sites; `/plex/connect` reordered | 7.2 |
| SEC-06 duplicate-URL 409 can make setup un-retryable | Resolved by construction: a leftover server row puts the instance in the recovery state, which adopts the row | 6.3, 7.3 |
| SEC-07 rate limiting enabled but unbounded here | Mandatory `customRules` entry plus a concurrency cap and a total outbound budget, all constants | 9 |
| SEC-09/10/11 | URL canonicalization and userinfo rejection; logger redaction plus a test; T7 wording corrected | 8.4, 10, 11 |

Corrections to statements revision 1 made as fact are in section 12.

## 1. Goal and requirement

The very first user of a fresh Tracearr instance should be able to establish their Emby server and
create the owner account using their Emby credentials, instead of inventing a separate local
password. Owner's words:

> "For the signup, I want to be able to put in the emby api token before signup, as to be able to
> natively use an emby account for the initial setup (so using the emby password)."

Read literally, the request names two credentials: an Emby **API token** entered before signup, and
the Emby **password** used for the signup itself. This design takes both, each for the distinct job
it is the right credential for (section 5).

### Non-goals for this increment

- Jellyfin or Plex native first-run setup. The flow is three verbs (verify-server,
  authenticate-user, persist-with-compensation) and generalizes, but this increment ships Emby only.
- Deciding the claim-code default. Revision 1 recommended default-on; the reviewer agrees and treats
  it as close to a prerequisite. It is owner decision 1 (section 11), not an architect decision.
- Deciding whether an in-app set-password surface ships here. Owner decision 2.
- OIDC changes, and any change to the local `/sign-up/username` handler itself.

One thing that *is* in scope and was not in revision 1: two small changes outside the new plugin,
because the design's own claims are false without them. `/emby/login` gains a fail-closed branch for
ambiguous server configuration (section 4), and `plexPlugin.ts` gains unique-violation mapping plus
a statement reorder (section 7.2).

## 2. The central tension: the `embyPlugin.ts` URL invariant

`apps/server/src/lib/embyPlugin.ts` (lines 30-34) carries a deliberate invariant:

> the server URL is NEVER taken from the client. It is resolved from the owner's own configured Emby
> server. Accepting a client URL would let an attacker point login at their OWN Emby (where they are
> trivially admin), satisfy the isAdmin gate, and get bound as the Tracearr owner (auth bypass), as
> well as drive SSRF.

And lines 130-138 fail closed when no owner exists:

> First-run owner creation is the local-signup flow (an Emby login can't bootstrap an owner: doing
> so would let an admin on ANY reachable Emby become the owner).

The requested feature needs a client-supplied URL at first run, which is what the NOTE forbids.
Revision 1 resolved this with "the invariant protects an existing owner, and at first run there is
no owner to hijack". The review showed that argument rests on an equivocation: the code's notion of
"first run" is "no `role='owner'` row", and an instance can be ownerless while holding the previous
operator's servers, users and tokens. Claiming such an instance is not bootstrapping, it is
takeover, and the existing owner-only `pg_dump` backup export then hands the attacker the plaintext
`servers.token` and Plex tokens.

So the refined invariant now names the state precisely, and the state has three values, not two:

> A client-supplied Emby URL is accepted by exactly one endpoint (`/emby/setup`), and only while the
> instance is **unclaimed**, meaning it holds no `users`, no `auth_accounts` and no `servers` rows at
> all. On an instance that is ownerless but holds data, `/emby/setup` ignores the client URL entirely
> and resolves it server-side exactly as `/emby/login` does, and requires the claim code
> unconditionally. Every authentication that can grant a session for an existing owner
> (`/emby/login`) resolves the URL server-side, never from the client, and fails closed when that
> resolution is ambiguous. Once an owner exists, `/emby/setup` returns 403 before reading the URL,
> before any outbound request, permanently.

The build must update the comment text of both `embyPlugin.ts` notes to reference `/emby/setup` as
the sanctioned bootstrap path, so the two files cannot drift into contradiction.

What remains true and must be stated to the operator: **an unclaimed, reachable instance is claimable
by whoever arrives first.** This feature does not create that exposure (SR-03 already describes it
for `/sign-up/username`). Section 10 states precisely when it does and does not widen it.

## 3. The instance state model (the SEC-01 fix)

A single predicate replaces `assertSignupAllowed()` as the setup endpoint's gate. It is a new
function in `apps/server/src/lib/authGuards.ts` so every claim path can adopt it later:

```ts
export type InstanceClaimState = 'unclaimed' | 'ownerless-with-data' | 'owned';

export async function getInstanceClaimState(): Promise<InstanceClaimState>;
```

Derivation, four `limit(1)` selects issued in parallel:

| owner row | any `users` row | any `auth_accounts` row | any `servers` row | state |
|---|---|---|---|---|
| yes | - | - | - | `owned` |
| no | no | no | no | `unclaimed` |
| no | otherwise any of the three present | | | `ownerless-with-data` |

How each state is reached, and what `/emby/setup` does:

**`owned`.** The normal post-setup life of the instance. 403 with the same fixed message the signup
path returns, as the handler's first statement, before the body is parsed and before any outbound
request. This is what closes the endpoint permanently.

**`unclaimed`.** A genuinely fresh instance. The full flow runs (section 6.2), the client URL is
honored, and the claim code is enforced when enabled. This is the only state in which a
client-supplied URL is ever accepted.

**`ownerless-with-data`.** Reachable by: an owner deleted through the better-auth admin plugin's
user-removal surface (the plugin is registered with `adminRoles: ['owner']`, `auth.ts:285`); a
partial restore; a support intervention; or a compensation failure in this very flow (section 7.3).
In this state:

1. The claim code is **required unconditionally**, whatever the default. If no claim code is
   configured at all, the endpoint refuses with an operator-facing message and logs at error level.
   The instance cannot be claimed from the network until the operator sets `CLAIM_CODE` and restarts,
   or recovers through the CLI.
2. The client-supplied `serverUrl` is **ignored**. The URL is resolved server-side through the same
   deterministic resolver `/emby/login` uses (section 4). If no `emby` server row exists, or if
   resolution is ambiguous, the endpoint refuses with the operator-facing message and performs no
   outbound request.
3. The supplied `apiKey` may update the existing row's token, but only after it verifies as admin
   against the resolved URL. It never changes the row's URL.

The refusal message is deliberately operator-facing rather than uniform, because this state is
already visible to any unauthenticated client: `GET /setup/status` returns `needsSetup: true`
together with `hasServers` and `hasPasswordAuth` (`routes/setup.ts:37-44`). Nothing new is disclosed.
It reads roughly: "This instance holds existing data but has no owner. Setup is disabled. Recover
from the server console with `pnpm --filter @tracearr/server cli promote-owner <username>` and then
`pnpm reset-password`." See section 7.4 for why that CLI command has to be added here.

**Loud persistent operator signal.** After migrations complete, startup computes the state. On
`ownerless-with-data` it logs at error level with the greppable marker
`OWNERLESS_INSTANCE_WITH_DATA`, and a scheduled job repeats that log hourly until the state clears.
Every refused setup attempt in this state also logs at error level with the same marker. "Persistent"
here means recurring in the log, not a new API field: adding a status flag would be a contract change
for information the operator reads from the console anyway.

**Local signup in this state is untouched by this increment.** `/sign-up/username` still lets an
arrival claim an ownerless-with-data instance without any Emby. That is pre-existing behavior and
outside this endpoint, but the takeover reasoning applies to it just as much, minus the server-URL
half. Extending `getInstanceClaimState()` to gate every claim path is the correct fix and is owner
decision 6, because refusing local signup in that state could equally block a legitimate operator
recovering a restored backup.

## 4. Deterministic Emby server resolution (the SEC-02 fix)

Counted, from `embyPlugin.ts:85-92`: `resolveConfiguredEmbyServerUrl()` selects
`where(eq(servers.type,'emby')).limit(1)` with no `ORDER BY`. With two `emby` rows, PostgreSQL may
return either, and the choice can differ between calls. Two rows therefore mean two authentication
authorities. Revision 1's guard was a URL-equality check, which fires only when the URLs match, that
is, only in the case that is harmless. Combined with SEC-01 this reaches the exact bypass the NOTE
exists to prevent, through the endpoint the design promised not to touch.

Three changes, the first two unconditional:

**4.1 `/emby/login` fails closed on ambiguity.** `resolveConfiguredEmbyServerUrl()` selects with
`limit(2)` and an explicit `orderBy(asc(servers.createdAt), asc(servers.id))`. Zero rows keeps the
current 400. More than one row throws `APIError('SERVICE_UNAVAILABLE')` with a fixed message
("Emby login is unavailable: more than one Emby server is configured") and logs at error level. It
never silently picks. This is the one behavioral change to `embyPlugin.ts` in this increment; the
file's NOTE and its no-owner branch are otherwise unchanged.

**4.2 Setup never creates a second `emby` row.** In `unclaimed` there are no server rows by
definition, so the insert is unambiguous. In `ownerless-with-data` the existing row is adopted, never
duplicated (section 3). There is no code path in this design that inserts an `emby` row when one
already exists.

**4.3 The database constraint depends on owner decision 3.** Whether more than one Emby server is a
supported configuration is a product question, so both designs are specified and the build takes
whichever the owner picks:

- **Design A, single Emby is the product rule.** Add to the same migration as `users_single_owner`:
  `CREATE UNIQUE INDEX servers_single_emby ON servers (type) WHERE type = 'emby';`. At most one
  `emby` row can exist database-wide, so 4.1's ambiguity branch becomes unreachable and stays only as
  defense in depth. `POST /servers` must map the violation to a 409 with an explanatory message.
  Upgrade risk: an instance that already has two `emby` rows fails the migration and does not boot,
  so the migration carries the same actionable guard described in 7.1.
- **Design B, multiple Emby servers are supported.** No uniqueness constraint. Instead, authentication
  authority becomes explicit: add `servers.is_auth_authority boolean not null default false` with
  `CREATE UNIQUE INDEX servers_single_auth_authority ON servers (is_auth_authority) WHERE
  is_auth_authority;`. `/emby/login` resolves the authority row and fails closed when none is set.
  Setup sets the flag on the row it creates or adopts. `POST /servers` gains a way to move the flag,
  which is an owner-authenticated operation. This is more surface, and it is only worth building if
  the answer to decision 3 is yes.

Until decision 3 lands, 4.1 alone makes the current behavior safe: ambiguity fails closed instead of
choosing an arbitrary authority.

## 5. Decision: token and password, each for its own job

The two credentials do different work and neither substitutes for the other.

**The admin API key** becomes `servers.token`, the long-lived polling credential the `servers` row
requires (`token: text NOT NULL`, stored plaintext per the existing "DB is localhost-only" decision
in `servers.ts`). It is validated with `verifyServerAdmin`, exactly as the post-setup add-server flow
does. An API key alone cannot create the owner: Emby API keys carry no user identity, so `/Users/Me`
does not resolve to a user for them (visible in `verifyServerAdmin`'s fallback to `/Auth/Keys`,
`emby/client.ts:173-210`), which leaves no `accountId` to bind in `auth_accounts` and nothing for a
later `/emby/login` to match.

**The Emby username and password** authenticate the human through `EmbyClient.authenticate` against
the just-verified URL, must return `isAdmin: true`, and yield the `authResult.id` bound as the
owner's Emby identity in `auth_accounts` (provider `emby`). That is the same bind `/emby/login`
performs on first use, so every subsequent Emby login works with no extra state.

Why not password-only, deriving the server token from the user's access token: user access tokens are
revocable (sign-out-all-devices, password change) in a way dedicated API keys are not
(**inferred - unverified**, consistent with Emby's documentation and with this repo's own choice to
take API keys in `POST /servers`; verifiable against a live Emby 4.9 by revoking sessions and
observing which credential survives). It also diverges from how every other server row is
provisioned, and the owner explicitly asked for the token step.

Why not token-only: no user identity to bind, and the owner explicitly said "using the emby password".

## 6. The flow

### 6.1 New endpoint

`POST /api/auth/emby/setup`, a better-auth endpoint (path constant `EMBY_SETUP_PATH = '/emby/setup'`),
registered by a new plugin `embySetupPlugin` in a new file
`apps/server/src/lib/embySetupPlugin.ts`, listed in `auth.ts`'s `plugins` next to `embyPlugin()` and
`signupPlugin()`. A separate file keeps `embyPlugin.ts`'s "only credentials are accepted here"
property verifiable at a glance and gives the build wave one writer per file.

Request body (zod, local to the plugin, matching `signupPlugin`'s precedent; the shared package
carries constants and types, not zod schemas):

```
{
  serverUrl:  string (min 1)        // Emby base URL, e.g. http://192.168.1.10:8096
  serverName: string (optional)     // display name; default "Emby"
  apiKey:     string (min 1)        // Emby admin API key -> servers.token
  username:   string (min 1)        // Emby account username
  password:   string                // Emby account password
  claimCode:  string (optional)     // enforced by the centralized hook, and unconditionally
                                    // in the ownerless-with-data state
}
```

`serverUrl` stays required in the schema even though the `ownerless-with-data` path ignores it, so
the contract does not vary by a state the client cannot observe. The response reports the URL that
was actually used.

Error responses carry a machine-readable code (section 13, item 3) so the web client renders its own
copy. No server-side error string ever contains an upstream status, status text, or response body
(SEC-03c).

### 6.2 Happy path in the `unclaimed` state (order is load-bearing)

1. **Claim-code gate.** The centralized `hooks.before` in `auth.ts` matches
   `ctx.path === EMBY_SETUP_PATH` and calls `assertClaimCode(body.claimCode)`, the same one-line
   pattern as `SIGN_UP_USERNAME_PATH`. Runs before the handler and therefore before any outbound
   request.
2. **State gate.** `getInstanceClaimState()` as the handler's first statement, before the URL is
   parsed. `owned` gives 403 with the signup path's message. `ownerless-with-data` branches to 6.3.
3. **Concurrency gate.** Acquire one of `MAX_CONCURRENT_SETUP_PROBES` slots (section 9). No slot
   available gives 503 with code `BUSY` and no outbound request.
4. **URL vetting and canonicalization.** Parse, reject userinfo, query, fragment and any path beyond
   `/` (SEC-09), lowercase the host, drop a default port, and keep only `origin`. That canonical
   origin is what gets probed, stored and echoed; the raw input is never stored and never appears in
   an error string. Then the hardened pre-flight check of section 8. Rejection gives 400 with code
   `URL_REJECTED` and a fixed message.
5. **Server verification.** `EmbyClient.verifyServerAdmin(apiKey, canonicalUrl)` through the safe
   fetcher. `CONNECTION_FAILED` gives 503 `SERVER_UNREACHABLE`, `INVALID_KEY` gives 401
   `KEY_REJECTED`, `NOT_ADMIN` gives 403 `KEY_NOT_ADMIN`. The upstream message is logged, not
   returned.
6. **Human authentication.** `EmbyClient.authenticate(canonicalUrl, username, password)` through the
   same safe fetcher. `null` gives 401 `BAD_CREDENTIALS`. `isAdmin === false` gives 403
   `NOT_EMBY_ADMIN`.
7. **Persist, compensated (section 7.3).**
   a. `internalAdapter.createUser({ name: username, username })`, which runs the same `user.create`
      hook chain as the better-auth signup paths: `assertSignupAllowed` again as defense in depth,
      forced `role: 'owner'`, and the username plugin's normalization and uniqueness. No `email`
      (column nullable) and no `passwordHash`, which is the point of the feature.
   b. Insert the `servers` row: `{ name: serverName ?? 'Emby', type: 'emby', url: canonicalUrl,
      token: apiKey, color: pickServerColor(...) }`, the same shape `POST /servers` uses.
   c. Insert the `auth_accounts` link `{ providerId: 'emby', accountId: authResult.id, userId,
      accessToken: authResult.token }`, the same insert `embyPlugin.ts` performs on first bind.
   d. `internalAdapter.createSession` plus `setSessionCookie`, through the same helper shape as
      `createEmbySession`.
8. **Response.** `{ authorized: true, user: { id, username, role: 'owner' }, server: { id, name, url } }`
   as the shared type `EmbySetupResult` (section 13).

### 6.3 The `ownerless-with-data` branch

Same numbered steps with three differences, all from section 3: the claim code is required whatever
the configured default (missing configuration is itself a refusal, code `INSTANCE_RECOVERY`); step 4
is skipped because the URL comes from `resolveConfiguredEmbyServerUrl()` rather than the body; and
step 7b adopts the existing `servers` row instead of inserting, updating its token only when the
supplied key verified in step 5 and never touching its URL.

### 6.4 Failure paths

| Step | Condition | HTTP | Code | State left behind |
|---|---|---|---|---|
| 1 | claim code required, missing or wrong | 403 | `CLAIM_CODE` | none |
| 2 | owner already exists | 403 | `INSTANCE_OWNED` | none |
| 2 | ownerless with data, no claim code configured, or no resolvable Emby server, or ambiguous resolution | 403 | `INSTANCE_RECOVERY` | none, no outbound request |
| 3 | concurrency cap reached | 503 | `BUSY` | none |
| 4 | malformed URL, userinfo, query or fragment present, blocked scheme, denied literal or resolved address | 400 | `URL_REJECTED` | none, no outbound request |
| 5 | Emby unreachable, or the probe was redirected | 503 | `SERVER_UNREACHABLE` | none |
| 5 | API key rejected | 401 | `KEY_REJECTED` | none |
| 5 | API key not admin | 403 | `KEY_NOT_ADMIN` | none |
| 6 | bad username or password | 401 | `BAD_CREDENTIALS` | none |
| 6 | account is not an Emby admin | 403 | `NOT_EMBY_ADMIN` | none |
| 7a | single-owner unique index violated (lost the race) | 403 | `INSTANCE_OWNED` | none, their insert never landed |
| 7b-7d | any persistence or session failure | 500 | `SETUP_FAILED` | none after compensation, or the recovery state plus a logged marker if compensation itself failed |

The web client surfaces each code on the relevant field group: URL and key for `URL_REJECTED`,
`SERVER_UNREACHABLE`, `KEY_REJECTED`, `KEY_NOT_ADMIN`; username and password for `BAD_CREDENTIALS`
and `NOT_EMBY_ADMIN`; the form as a whole for the rest.

### 6.5 Frontend (web)

`apps/web/src/pages/Login.tsx` already owns the setup-versus-signin mode switch driven by
`GET /api/setup/status` (`needsSetup`, `requiresClaimCode`, `authMethods`). Changes:

- When `needsSetup && authMethods.emby`, the setup card offers two modes: "Set up with Emby" (new,
  listed first) and "Create local account" (the existing `/sign-up/username` form, unchanged).
- The Emby mode renders server URL, server name (optional), API key, username, password, plus the
  claim code when `requiresClaimCode`, reusing the existing claim-code step. It posts to
  `EMBY_SETUP_PATH` through `authClient.$fetch`, the same transport the page already uses for
  `SIGN_UP_USERNAME_PATH` and `/emby/login`.
- Error rendering is driven by the response code, not by server prose (section 6.4).
- If owner decision 2 lands as "CLI-only recovery", the Emby mode carries a short, permanent notice:
  this account will have no local password, and if Emby becomes unreachable, recovery requires
  console access. See section 11.
- On success the session cookie is set by the server; follow the post-login navigation the existing
  Emby login handler uses.
- No `SetupStatus` change (section 12, item 3 of "decisions not taken").

Mobile: out of scope. First-run setup is a web concern.

## 7. Persistence, constraints and compensation

### 7.1 The single-owner constraint, established where it cannot be skipped (the SEC-04 fix)

Revision 1 put `users_single_owner` in `createPartialIndexes()`. Counted: that function
(`timescale.ts:662-723`) has exactly one caller, wrapped in a try/catch that logs `console.warn` and
records "Partial indexes: some may already exist" (`timescale.ts:1734-1740`). A failure is therefore
downgraded to a benign-looking warning, and because the statements are sequential `await`s in one
function, every index declared after a failing one is skipped. An auth-integrity constraint cannot be
established that way.

It moves to a drizzle migration in `apps/server/src/db/migrations/`. Counted: migration failure
aborts startup, because `runMigrations` is awaited inside a try/catch that logs and rethrows
(`index.ts:607-615`), which is the correct mode for this constraint. The repo already has the
precedent of a unique index created by migration rather than at startup
(`users_login_username_unique`, asserted by `db/__tests__/loginUsernameCollision.integration.test.ts`).

The statement uses the form the reviewer confirmed as unambiguously valid:

```sql
CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner';
```

Semantics: at most one row may have `role='owner'`, because all such rows share the identical
indexed value. Revision 1 wrote `ON users ((true))` and asserted it as fact without a verification
note; that was an unlabelled inference and the `(role)` form replaces it.

Because the migration aborts startup, an instance that already holds two owner rows (SR-02 having
fired historically) would fail to boot with a raw index error. The migration therefore opens with a
guard that raises an actionable exception instead:

```sql
DO $$
BEGIN
  IF (SELECT count(*) FROM users WHERE role = 'owner') > 1 THEN
    RAISE EXCEPTION 'Tracearr: % owner rows found. Resolve to exactly one owner, then restart. See docs/delivery/runbook.md.',
      (SELECT count(*) FROM users WHERE role = 'owner');
  END IF;
END $$;
```

Revision 1 chose to degrade (log and continue) rather than block an upgrade. That is the wrong
trade for a constraint whose absence is an auth-integrity hole, and it is what the review objected
to. Failing closed with an actionable message is the choice here; the runbook carries the resolution
steps.

**Post-migration assertion.** After migrations, startup queries `pg_indexes` for
`users_single_owner` (and, under design A, `servers_single_emby`) and logs at error level with the
marker `MISSING_SECURITY_INDEX` if absent. Belt and braces: the migration should make absence
impossible, and the assertion is what proves it on a real boot (verification case in section 14).

### 7.2 The funnel is the database, not the hook chain (the SEC-05 fix)

Revision 1 wrote that "every signup path funnels through the `user.create` before-hook". That is
false. Counted: `plexPlugin.ts:351-360` and `plexPlugin.ts:487-496` insert owner rows directly with
drizzle, so the better-auth hook never runs for them. The corrected statement:

> The single-owner guarantee comes from the database index. It holds for every path, including the
> two Plex paths that bypass the better-auth hook chain entirely. The `user.create` hook is defense
> in depth on the paths that pass through it, not the funnel.

Two consequences that this increment fixes, because otherwise the design's own "SR-02 is closed
globally" claim ships with new 500s and a new orphan row:

1. **Map the violation at both Plex sites.** A race loser currently surfaces a raw unique-violation
   as a 500. Both inserts get the same mapping the setup path uses: match `users_single_owner` in the
   error message (the technique `embyPlugin.ts` already uses for its own index) and return 403 with
   the standard "already has an owner" message.
2. **Reorder `/plex/connect`.** Counted: the `servers` insert or token update (`plexPlugin.ts:453-483`)
   currently precedes the user insert (`487-496`), so a race loser leaves an orphan server row, and an
   existing row's token has already been overwritten. The contended user insert moves first, matching
   the ordering principle in 7.3. The server write and the `plexAccounts` and `auth_accounts` writes
   follow, and the existing compensation shape covers them.

Both are backend-only changes in a file the setup plugin does not touch, so they are a separate
commit in the same increment.

### 7.3 Compensated persistence (no half-applied setup)

`internalAdapter.createUser` commits its own row, and nothing after it is transactional with it (the
constraint is documented at length in `signupPlugin.ts`'s header). A single raw drizzle transaction
would be atomic but would bypass the better-auth hook chain (role forcing, username normalization
and uniqueness, the defense-in-depth signup gate) and duplicate its logic. Rejected, see ADR-0009
option 3.

So: compensation, ordered so the contended step is first.

1. `createUser` first, because it is the race gate. If it loses, nothing else exists yet.
2. Then the `servers` write, the `auth_accounts` link and the session, each wrapped so that on any
   failure the handler deletes in reverse order whatever it created: the `servers` row if it was
   *inserted* by this attempt (never a row it adopted), then the user through
   `internalAdapter.deleteUser`, which cascades sessions and `auth_accounts` per the `signupPlugin.ts`
   precedent. Then rethrow as 500 `SETUP_FAILED`. Compensation failures never mask the original error.

Why the orphan matters more than the mess: a committed owner row with no server and no Emby link
would permanently lock the instance, because `assertSignupAllowed` then rejects every retry while
`/emby/login` fails with "No Emby server is configured" and local login has no credential.

**When compensation itself fails** (the SEC-06 case), the log carries the marker
`INSTANCE REQUIRES MANUAL RECOVERY` at error level, names which artifacts survived, and names the
tools: `pnpm --filter @tracearr/server cli list-users`, `... cli promote-owner <username>` (new,
section 7.4), `pnpm reset-password` (`apps/server/scripts/reset-password.ts`).

**Retryability.** Revision 1 guarded duplicate URLs with a 409, and the review showed that a leftover
server row then blocks every retry permanently. Under the state model that cannot happen: a leftover
`servers` row puts the instance in `ownerless-with-data`, whose branch adopts the existing row
(section 6.3). The 409 is gone. The cost is that retry in that state requires a claim code, so an
instance with no `CLAIM_CODE` configured needs the operator to set one and restart. That coupling is
a direct argument for owner decision 1, and it is stated rather than hidden.

### 7.4 Recovery has to exist for the refusal to be honest

Counted: `apps/server/scripts/reset-password.ts` selects the first `role='owner'` user and exits with
an error when there is none (`reset-password.ts:38-56`). `apps/server/scripts/cli.ts` exposes
`reset-password`, `set-username`, `set-email`, `list-users` and `enable-local-login`
(`cli.ts:111-123`). None of them can promote a user to owner. So on an `ownerless-with-data` instance,
which section 3 deliberately refuses to let anyone claim from the network, the documented recovery
path does not currently work.

This increment therefore adds one CLI command, `promote-owner <username>`, in `cli.ts`: it refuses if
an owner already exists, sets `role='owner'` on the named user, and prints the follow-up
`reset-password` invocation. It is console-only, it is guarded by the same single-owner index, and it
is what makes the SEC-01 refusal a recovery rather than a brick. Not contract surface; backend work.

## 8. Outbound probe hardening (the SEC-03 fix)

Revision 1 listed `assertSafeProbeUrl` as control number one. The function's own doc comment says
hostname URLs are not DNS-resolved and that it is "defense-in-depth only" (`ssrf.ts:57-63`).
Promoting a defense-in-depth check to a primary control was the error. This section replaces it for
this path.

### 8.1 A new module, not a change to `fetchJson`

`fetchJson` is shared by the Plex, Ombi, Seerr, Jellyfin and Emby clients (`utils/http.ts`). Changing
its redirect behavior globally would silently alter every one of those integrations, so the hardening
lands in a new module and is opted into:

```
apps/server/src/utils/safeProbe.ts
  export class ProbeBlockedError extends Error {}   // pre-flight rejection
  export class ProbeFailedError extends Error { code: 'UNREACHABLE' | 'REDIRECTED' }
  export async function safeProbeJson<T>(url, opts): Promise<T>
```

`EmbyClient.verifyServerAdmin` and `EmbyClient.authenticate` gain an optional trailing parameter, a
JSON fetcher defaulting to `fetchJson`. The setup plugin passes `safeProbeJson`. `/emby/login` and
`POST /servers` keep today's behavior, so this increment cannot regress them. Passing the safe
fetcher everywhere is the correct end state and is tracked as a follow-up, coupled to owner
decision 5.

### 8.2 What `safeProbeJson` does, in order

1. Pre-flight the URL with the hardened `assertSafeProbeUrl` (8.3), on the canonical origin from
   step 6.2.4.
2. Resolve the hostname with `dns.promises.lookup(host, { all: true })`. Every returned address must
   pass the address rules of 8.3. An empty result, or any denied address, rejects the whole request:
   there is no "use the good one" fallback, because a name that resolves to both a legitimate and a
   denied address is exactly the rebinding shape being defended against.
3. Connect with the resolved and validated address pinned, so the address checked is the address
   used. Intended mechanism: an undici `Agent` whose `connect.lookup` returns only validated
   addresses, re-running the address rules at connect time (**inferred - unverified**: that undici's
   connect options forward a custom `lookup` to `net`/`tls` in the version bundled with this repo's
   Node runtime. Verification: a build-time spike asserting that a `lookup` returning a denied
   address is rejected, and that TLS SNI still carries the original hostname. Fallback if
   unsupported: request the validated literal IP with an explicit `Host` header and, for https, an
   explicit `servername`, and document the certificate implications).
4. Set `redirect: 'manual'`. Any 3xx is a hard failure, `ProbeFailedError('REDIRECTED')`. Nothing is
   followed. This closes the `302 Location: http://169.254.169.254/...` bypass and, more seriously,
   the `307` variant that preserves method and body and would turn the authenticate step into an
   arbitrary internal JSON POST.
5. Apply the per-request timeout and the shared total budget of section 9.
6. Throw only errors whose message is safe to return. Upstream status, status text and body are
   logged server-side with the request id and never cross the response boundary (SEC-03c). The
   client-facing distinction stops at the code list in 6.4.

### 8.3 Address rules, applied to literals and to every resolved address

Denied:

- Any scheme other than http and https.
- `0.0.0.0/8` (this-network and the unspecified address) and `::`.
- `169.254.0.0/16` and `fe80::/10` (link-local, including the AWS, Azure and GCP metadata address).
- `fd00:ec2::254` (AWS IPv6 metadata) and `192.0.0.192` (Oracle metadata).
- `224.0.0.0/4` and `ff00::/8` (multicast), `255.255.255.255` (broadcast).
- IPv4-mapped IPv6 forms of every IPv4 rule above. The existing decoder
  (`extractIPv4FromMapped`, `ssrf.ts:37-55`) is reused, but its result now runs the *full* rule set
  rather than only the link-local check.

Deliberately still allowed, because blocking them would break the product's primary audience:

- Loopback `127.0.0.0/8` and `::1`.
- RFC1918 `10/8`, `172.16/12`, `192.168/16`.
- CGNAT and Tailscale `100.64.0.0/10`.

One consequence worth naming rather than discovering later: Alibaba Cloud's metadata address
`100.100.100.200` sits inside `100.64.0.0/10`, so denying it would break the Tailscale range the
existing tests explicitly allow (`ssrf.test.ts:84-88`). It stays reachable. On Alibaba Cloud only,
that is a residual within the residual, and it is part of owner decision 4.

### 8.4 What is stored and what is echoed

Only the canonical origin from step 6.2.4 reaches `servers.url`, an error string or a log line. A URL
carrying userinfo (`http://user:pass@host:8096`) is rejected outright rather than stripped, because
silently accepting it teaches the operator that pasting credentials into the field is fine (SEC-09).

## 9. Rate limiting and the outbound budget (the SEC-07 fix)

Counted, correcting revision 1's inferred-unverified note: better-auth's limiter is explicitly
enabled in this repo, `rateLimit: { enabled: rateLimitEnabled, storage: 'secondary-storage' }` with
the option defaulting to `true` and a comment explaining why it is not environment-derived
(`auth.ts:130-146, 232-237`). Also counted: there are no `customRules` anywhere in
`apps/server/src`, so only the global default applies, and the Fastify-level limiter is
`max: 1000, timeWindow: '1 minute'` (`index.ts:312-315`), which is not a meaningful bound for a path
that can hold four sequential outbound waits open.

Three constants, all module-level, none derived from the request:

```ts
export const SETUP_RATE_LIMIT = { window: 60, max: 5 } as const;  // per IP
export const MAX_CONCURRENT_SETUP_PROBES = 2;
export const SETUP_PROBE_TIMEOUT_MS = 5_000;
export const SETUP_TOTAL_BUDGET_MS = 15_000;
```

- A `customRules` entry keyed on `EMBY_SETUP_PATH` in the `rateLimit` block of `auth.ts` carries
  `SETUP_RATE_LIMIT` (**inferred - unverified**: that better-auth 1.6.23 spells this
  `rateLimit.customRules['<path>'] = { window, max }`; verification is a one-line check against the
  installed package's types during build, and the fallback is a Fastify-level route rule).
- `MAX_CONCURRENT_SETUP_PROBES` is an in-process counter acquired at step 6.2.3 and released in a
  `finally`. Exceeding it returns `BUSY` with no outbound request. It is per process, so a multi-replica
  deployment multiplies it; that is acceptable because the per-IP rule is shared through Redis and
  self-hosted Tracearr is single-replica in practice.
- Every probe uses `SETUP_PROBE_TIMEOUT_MS` rather than the client's 10 s default, and all probes in
  one request share an `AbortSignal` bounded by `SETUP_TOTAL_BUDGET_MS`. Worst case per request drops
  from about 40 s to 15 s, which is what makes the per-IP rule an actual scanning bound.

## 10. Threat model for this path

| # | Threat | Disposition |
|---|---|---|
| T1 | Post-setup auth bypass: attacker points a login-ish endpoint at their own Emby, passes isAdmin, binds as owner (the `embyPlugin.ts` NOTE's attack) | Closed by construction. `/emby/login` still resolves the URL server-side, and now fails closed when that resolution is ambiguous (section 4.1). `/emby/setup` returns 403 in the `owned` state before reading the URL. The `users_single_owner` index, now created by migration, backstops the race variant. |
| T2 | Takeover of an ownerless-but-populated instance (the SEC-01 attack): claim it, become owner, then use the owner-only `pg_dump` backup export to read plaintext `servers.token` and Plex tokens | Closed for this endpoint by section 3: the client URL is ignored, the URL is resolved server-side, and the claim code is required unconditionally, so a network attacker with no claim code cannot claim the instance at all. Startup and every refusal log `OWNERLESS_INSTANCE_WITH_DATA`. Residual: `/sign-up/username` still permits the claim half in that state, which is pre-existing and is owner decision 6. |
| T3 | Drive-by claim of a genuinely unclaimed instance (SR-03) | Not widened by this path. An unclaimed instance is already claimable through `/sign-up/username` with no Emby at all, and proof-of-Emby-admin cannot distinguish the legitimate operator's Emby from an attacker's own box, so it is not usable as an authentication factor at first run. The claim-code gate applies with full parity. The real fix is claim-code default-on, owner decision 1, which the reviewer treats as close to a prerequisite for this feature. |
| T4 | SSRF and internal probing through `serverUrl` | Section 8: canonicalization and userinfo rejection, a widened deny list applied to literals and to every resolved address, manual redirects with 3xx as hard failure, connect-time re-validation, fixed request shapes, no response echo, no upstream status in client errors, the unclaimed-only window, claim-code precedence, and the bounds of section 9. Residual, stated plainly: loopback and RFC1918 stay allowed by deliberate policy, so an unauthenticated party who can reach an unclaimed instance can still learn whether an internal `host:port` answers, at 5 requests per minute per IP with a 15 s budget. Owner decision 4. |
| T5 | Concurrent-claim race (SR-02) | Closed at the database by `users_single_owner`, now created by a migration that aborts startup on failure and is asserted present on boot (7.1). Race losers map to 403 on the setup path and, after 7.2, on both Plex paths too. |
| T6 | Credential exposure in transit: the Emby password and API key are relayed to an operator-typed URL, possibly over http | Same posture as `/emby/login` and `POST /servers` today, both of which accept http, which is the homelab reality. The password goes only to the URL the same user typed into the same form, so there is no confused deputy. Body fields are never logged (section 11), and error messages never echo credentials. |
| T7 | Token at rest | `servers.token` stays plaintext, an existing and deliberate repo decision ("DB is localhost-only", `servers.ts:19`). No change and no new copies. `auth_accounts.accessToken` stores the user token exactly as `/emby/login` already does. T2 is the reason this matters: the backup export is the amplifier, which is why the state gate is the control. |
| T8 | State probing of the endpoint | Post-setup, every request in the `owned` state gets the same fixed 403 with the signup path's message, before any I/O. Correcting revision 1's wording, which the review found inexact: the responses are *not* uniform across all states, and cannot be. With the claim code enabled an attacker without the code sees `CLAIM_CODE`; on an ownerless-with-data instance they see `INSTANCE_RECOVERY`. Neither discloses anything `GET /setup/status` does not already publish (`needsSetup`, `hasServers`, `hasPasswordAuth`, `routes/setup.ts:37-44`). The property that matters is narrower and does hold: **once an owner exists, the endpoint is indistinguishable from the local signup path and performs no I/O.** |
| T9 | Owner lockout by an Emby outage: the owner has no local password, Emby is down, so they cannot log in | Accepted trade-off, inherent to "no separate local password" as requested. Correcting revision 1: there is **no in-app set-password surface**. The only recovery is console access to `pnpm reset-password` (`apps/server/scripts/reset-password.ts`), which requires an existing owner row and prompts for a new password. `/setup/status.hasPasswordAuth` already models password-less instances, and OIDC remains available when configured. Whether to build an in-app set-password endpoint in this increment is owner decision 2; if the answer is no, the setup screen carries the warning (6.5) and the runbook carries the exact command. |
| T10 | Pre-auth outbound probing as a *new* capability | It is not new. Correcting revision 1: `/plex/connect` (`plexPlugin.ts:399-446`) already accepts a client-supplied `serverUri` on an unauthenticated pre-claim endpoint. It is guarded, contrary to the review's wording: `PlexClient.verifyServerAdmin` calls `assertSafeProbeUrl` first (`plex/client.ts:628-637`). But it is guarded by the literal-only check, so it follows redirects, never resolves hostnames, and is not re-validated on connect. The new endpoint is therefore a *better-behaved instance of an existing capability*, and fixing the class properly means routing `/plex/connect` through `safeProbeJson` as well. Owner decision 5. |

## 11. Owner decisions

**This section is the decision list. Nothing in it has been decided by the architect.** Each item
states the trade-off and what this design does in the meantime.

1. **Claim code: default-on, persistence, single-use.** Today the code exists only when `CLAIM_CODE`
   is set in the environment (`utils/claimCode.ts:61-79`); unset means the gate is off. The reviewer
   agrees with revision 1's recommendation to auto-generate and print a code when the variable is
   unset, and treats it as close to a prerequisite for this feature. The detail revision 1 missed:
   an auto-generated code **must persist across restarts**, or every container restart invalidates the
   code the operator copied from the log. The `settings` table is the obvious home
   (`services/settings.ts` already provides typed `getSetting`/`setSetting`), with one ordering
   consequence worth knowing before committing: `initializeClaimCode()` currently runs before the
   database is available (`index.ts:1214-1219`), so persistence means moving or splitting that
   initialization to after migrations. Also open: is the code single-use (consumed by the first
   successful claim) or valid until the instance is claimed? This design works under either default;
   note that section 7.3's retryability after a failed compensation depends on a code being available.
2. **In-app set-password surface, or documented CLI-only recovery.** T9. Either this increment adds an
   authenticated `set-password` endpoint plus a settings-screen field, so an Emby-native owner can
   establish a fallback credential, or the answer is CLI-only and the design ships the setup-screen
   warning (6.5) plus the exact command in the runbook. Revision 1 assumed the surface existed; it
   does not, and that assumption was load-bearing for accepting the lockout.
3. **Is more than one Emby server a supported configuration?** Section 4.3 specifies design A
   (single-Emby product rule, enforced by a partial unique index) and design B (explicit
   authentication authority column). A is less surface and matches how `/emby/login` reads today; B is
   needed if multi-Emby is a real use case. Until this lands, 4.1's fail-closed branch keeps the
   current behavior safe but leaves a multi-Emby instance unable to use Emby login at all.
4. **Accept or reject the residual SSRF exposure after mitigation.** Loopback and RFC1918 must stay
   allowed for self-hosted deployments, so an unclaimed, reachable instance still offers a bounded
   internal reachability oracle to whoever can reach it, plus the Alibaba metadata carve-out of 8.3.
   The reviewer judges this acceptable **provided the claim code is on by default**, which links this
   decision to item 1.
5. **Fix `/plex/connect`'s under-guarded probe in this increment, or track it separately.** T10. The
   fix is routing its probes through `safeProbeJson`, the same module this design introduces. Doing
   it here is cheap while the module is fresh; deferring it leaves the weaker instance of the same
   capability in place, which makes the security posture of the two endpoints inconsistent.
6. **Architect-surfaced, not in the reviewer's list: should the unclaimed gate apply to every claim
   path?** Section 3 gates `/emby/setup` on `getInstanceClaimState()`, but `/sign-up/username` and the
   OIDC first-signup still allow a claim on an ownerless-with-data instance. Extending the gate closes
   T2 completely; it also means an operator who restores a backup without users can no longer recover
   through the browser and must use the console. The guard is written as a reusable function either
   way.

## 12. Corrections to revision 1

Recorded explicitly, because downstream engineers implement these statements literally.

1. **"The owner can set a local password later from settings" was false**, and it was labelled
   inferred-unverified while carrying the weight of accepting the T9 lockout. There is no HTTP
   surface. Recovery is `pnpm reset-password` from the console, and that script requires an existing
   owner row (`reset-password.ts:38-56`). See owner decision 2.
2. **"Pre-auth outbound probing is the one new capability this path adds" was false.**
   `/plex/connect` already does it. The corrected framing is in T10, and it is a stronger position:
   the new endpoint is the better-behaved instance. Note that the review's own wording, that
   `/plex/connect` probes "with no SSRF check at all", is also inexact:
   `PlexClient.verifyServerAdmin` calls `assertSafeProbeUrl` first (`plex/client.ts:628-637`). The
   finding survives in the narrower form stated in T10.
3. **"Does not worsen SR-03" was true only for a genuinely fresh instance.** For an
   ownerless-but-populated one it was false, and materially so, because the backup export turns a
   claim into full credential disclosure. With sections 3 and 4 in place the claim becomes accurate,
   and it is now stated with that qualification attached (T2, T3).
4. **The `assertSafeProbeUrl` grep in revision 1's section 3 was counted over the wrong scope.** It
   claimed the only hits were `ssrf.ts`, its test, `ombi.ts` and `seerr.ts`. Re-derived across
   `apps/server/src` (`*.ts`), the hits also include `services/mediaServer/plex/client.ts:629` and
   `services/mediaServer/plex/connectionTest.ts:65`. The narrower claim the design actually needed:
   `EmbyClient.verifyServerAdmin` and `EmbyClient.authenticate` perform no SSRF check
   (`emby/client.ts:94-235`), so `POST /servers` is unguarded for `type: 'emby'` and `'jellyfin'` and
   guarded for `'plex'` inside the Plex client. A count taken over the wrong scope is still wrong.
5. **`ON users ((true))` was asserted without a verification note.** Replaced by
   `ON users (role) WHERE role = 'owner'`, which the reviewer confirms is unambiguously valid and
   semantically identical (7.1).

## 13. Existing building blocks (reuse, do not duplicate)

All re-verified in the worktree during this revision.

| Block | Where | Reused for |
|---|---|---|
| `EmbyClient.verifyServerAdmin(apiKey, url)` | `apps/server/src/services/mediaServer/emby/client.ts:146-235` | Validating the API key is admin-level; distinguishes `CONNECTION_FAILED` / `INVALID_KEY` / `NOT_ADMIN`. Gains an injectable fetcher (8.1) |
| `EmbyClient.authenticate(url, username, password)` | same file, `94-125` | Authenticating the human; returns the auth result or `null` on 401. Gains an injectable fetcher |
| `assertSafeProbeUrl` / `SsrfBlockedError` | `apps/server/src/utils/ssrf.ts` | Pre-flight URL vetting, widened per 8.3 and wrapped by `safeProbe.ts` |
| `assertSignupAllowed()` / `assertClaimCode()` | `apps/server/src/lib/authGuards.ts:9-25` | Kept as the hook-chain defense in depth; the endpoint's own gate is the new `getInstanceClaimState()` in the same file |
| Centralized claim-code hook | `apps/server/src/lib/auth.ts:256-277`, keyed on shared path constants | Claim-code enforcement for the new path (one added `ctx.path` comparison) |
| `internalAdapter.createUser` + the `user.create` before-hook | `auth.ts:238-254` (forces `role: 'owner'`, re-runs `assertSignupAllowed`) | Owner-user creation with the same hook chain as the better-auth signup paths. Not a universal funnel, see 7.2 |
| Compensation pattern | `apps/server/src/lib/signupPlugin.ts` (`linkCredentialAndCreateSession`) | The failure and rollback shape for multi-step persistence (7.3) |
| Emby identity link insert + `auth_accounts_one_emby_per_user` | `embyPlugin.ts` (insert), `db/timescale.ts:668-672` (index) | Binding the Emby account to the owner. Note the index's location is the pattern this revision deliberately moves away from for security constraints (7.1) |
| Migration-created unique index | `users_login_username_unique`, referenced by `db/__tests__/loginUsernameCollision.integration.test.ts:26-30` | The precedent for creating `users_single_owner` in a migration |
| Server-row creation shape | `apps/server/src/routes/servers.ts:104-161` | The `servers` insert mirrors it (name, type `emby`, url, token, color) |
| Session establishment | `embyPlugin.ts` `createEmbySession` | Logging the new owner in at the end of setup |
| CLI recovery commands | `apps/server/scripts/cli.ts:111-123`, `scripts/reset-password.ts` | The documented recovery path, extended with `promote-owner` (7.4) |

## 14. Contract freeze checklist (`packages/shared`)

Additive only; no existing entry changes. Each item names every mirror location that must gain an
entry and the barrel path a consumer imports it through.

1. **Constant** `EMBY_SETUP_PATH = '/emby/setup'` in `packages/shared/src/constants.ts`, with a
   comment block mirroring `SIGN_UP_USERNAME_PATH`'s: the claim-code hook keys on it and fails **open**
   if a second hand-typed literal drifts.
   - Mirror 1: `apps/server/src/lib/auth.ts` `hooks.before`, add `ctx.path === EMBY_SETUP_PATH` to the
     claim-code condition.
   - Mirror 2: `apps/server/src/lib/embySetupPlugin.ts`, `createAuthEndpoint(EMBY_SETUP_PATH, ...)`.
   - Mirror 3: `apps/server/src/lib/auth.ts` `rateLimit.customRules`, keyed on the same constant
     (section 9).
   - Mirror 4: `apps/web/src/pages/Login.tsx`, `authClient.$fetch(EMBY_SETUP_PATH, ...)`.
2. **Type** `EmbySetupResult` in `packages/shared/src/types.ts`:
   `{ authorized: true; user: { id: string; username: string; role: 'owner' }; server: { id: string; name: string; url: string } }`.
   The `server.url` field is the canonical origin actually used, which in the recovery branch is the
   server-resolved one rather than the submitted one (6.3).
3. **Type** `EmbySetupErrorCode` in `packages/shared/src/types.ts` (new in revision 2, required by
   SEC-03c so the client renders its own copy instead of server prose):
   `'CLAIM_CODE' | 'INSTANCE_OWNED' | 'INSTANCE_RECOVERY' | 'URL_REJECTED' | 'SERVER_UNREACHABLE' | 'KEY_REJECTED' | 'KEY_NOT_ADMIN' | 'BAD_CREDENTIALS' | 'NOT_EMBY_ADMIN' | 'BUSY' | 'SETUP_FAILED'`.
   - Mirror 1: the server-side error mapper in `embySetupPlugin.ts`, one arm per member.
   - Mirror 2: the copy map in `Login.tsx`, one message per member (exhaustive switch, so a future
     member is a compile error rather than a blank error box).
   - Mirror 3: the failure taxonomy table in 6.4, which is the authority both mirrors are checked
     against.
4. **Barrel exports** in `packages/shared/src/index.ts`: `EMBY_SETUP_PATH` in the constants export
   list, `EmbySetupResult` and `EmbySetupErrorCode` in the type export list. Reachability check:
   `import { EMBY_SETUP_PATH, type EmbySetupResult, type EmbySetupErrorCode } from '@tracearr/shared'`,
   the same surface `Login.tsx` already uses for `SIGN_UP_USERNAME_PATH` and `SetupStatus`.
5. **No shared zod schema.** The request-body zod stays local to `embySetupPlugin.ts`, the established
   precedent (`signUpUsernameBody`, `loginBody`).
6. **No socket event map entries.** Counted: the flow is request and response only, and nothing
   touches the realtime layer.
7. **No `SetupStatus` change.** `needsSetup && authMethods.emby` already carries the signal, and the
   recovery state is communicated by the endpoint's error code, not by a new status field.
8. **Database, part of the frozen boundary though not in `packages/shared`:** a new drizzle migration
   in `apps/server/src/db/migrations/` containing the duplicate-owner guard and
   `CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner'`, plus
   `servers_single_emby` (design A) or `servers.is_auth_authority` with its index (design B) once
   owner decision 3 lands. `users_single_owner` does **not** wait on that decision.

Everything else is implementation inside the frozen boundary: the plugin file, `safeProbe.ts`, the
`Login.tsx` form, the `embyPlugin.ts` resolver change and comment updates, the `plexPlugin.ts` fixes,
the `promote-owner` CLI command, and the tests.

### Build-wave split (one increment)

- **Backend, writer of `apps/server/src/**`:** `embySetupPlugin.ts` with unit tests including a pure
  decision and compensation function in the `decideEmbyOwnerLogin` style; `safeProbe.ts` plus the
  widened rules in `ssrf.ts`; `getInstanceClaimState()` in `authGuards.ts`; the `auth.ts` hook line,
  `customRules` entry and plugin registration; the migration and the post-migration assertion; the
  `embyPlugin.ts` resolver change and comment updates; the `plexPlugin.ts` mapping and reorder; the
  `promote-owner` CLI command; shared-package items 1 to 4.
- **Frontend, writer of `apps/web/src/**`:** the `Login.tsx` Emby-setup mode against items 1 to 4,
  mocked until the backend lands, with the error-code copy map and the lockout notice if owner
  decision 2 comes back CLI-only.
- **Seam:** the shared constants and types only. The frontend consumes `EMBY_SETUP_PATH`,
  `EmbySetupResult`, `EmbySetupErrorCode`, and the failure taxonomy in 6.4.
- **One writer per file:** `embyPlugin.ts` and `plexPlugin.ts` are touched by the backend engineer in
  this increment, so no parallel task may edit them.

## 15. Decisions not taken (and why)

1. **Not extending `/emby/login` with an optional URL-on-first-run parameter.** A separate endpoint
   keeps `embyPlugin.ts`'s "only credentials are accepted here" property a file-local invariant a
   reviewer can verify at a glance, and keeps the NOTE truthful. A dual-mode endpoint is exactly the
   shape the NOTE warns about. Endorsed by the review.
2. **Not accepting token-only or password-only.** Section 5.
3. **Not adding a `SetupStatus.embySetup` flag,** and not adding a recovery-state flag either.
   `needsSetup && authMethods.emby` already carries the signal for the first, and the second is
   communicated by an error code the client already has to handle.
4. **Not blocking RFC1918 or loopback.** It would break the primary self-hosted use case. The
   residual is stated in T4 and is owner decision 4 rather than hidden.
5. **Not changing `fetchJson`'s redirect behavior globally.** It is shared by five integrations; the
   hardening is opt-in through `safeProbe.ts` (8.1), with global adoption as a tracked follow-up.
6. **Not flipping the claim code to default-on in this increment.** It changes behavior for every
   fresh install on all setup paths. Owner decision 1, flagged rather than smuggled in.
7. **Not using a raw DB transaction for user creation.** It would bypass the better-auth hook chain;
   compensation per the `signupPlugin.ts` precedent instead (7.3, ADR-0009 option 3).
8. **Not implementing Jellyfin or Plex setup parity now.** The three verbs generalize, but each server
   type has its own auth quirks.
9. **Not setting a local password during Emby setup.** Avoiding an invented password is the feature's
   purpose. T9 documents the lockout and owner decision 2 owns the answer.
10. **Not gating `/sign-up/username` and OIDC on the new unclaimed state in this increment.** The
    guard is written to be reusable, but applying it changes recovery behavior for restored backups.
    Owner decision 6.

## 16. Verification map (for QA and security review)

Grouped by the finding each case exists to prove. Cases marked (new) come from the review.

**State gate (SEC-01)**
- Setup refused on an ownerless instance holding `servers` rows (new); the same with only `users`
  rows; the same with only `auth_accounts` rows.
- In that state the submitted `serverUrl` is ignored: a body pointing at an attacker host with a
  mocked fetch produces zero outbound calls to that host.
- In that state, with no claim code configured, the endpoint refuses and logs
  `OWNERLESS_INSTANCE_WITH_DATA` at error level (new).
- After a successful setup, `/emby/setup` returns 403 with the signup path's message and produces
  zero outbound HTTP (assert against a mocked fetch).

**Server resolution (SEC-02)**
- With two `emby` rows, `/emby/login` fails closed rather than picking one (new). Under design A, the
  second insert is rejected by `servers_single_emby` instead.
- Setup on an ownerless-with-data instance adopts the existing `emby` row and never creates a second.

**Outbound probes (SEC-03)**
- Redirect to metadata rejected: the probed host answers `302 Location: http://169.254.169.254/...`
  and the request fails without following (new). Repeat with `307` and a request body, asserting the
  body is never re-sent (new).
- Hostname resolving to a denied address rejected, with `dns.lookup` stubbed to return `169.254.169.254`
  and again to return both a public address and a denied one (new).
- Error responses free of upstream status text: the probed host answers 500 with a body, and the
  client-facing response contains only the fixed string and the code (new).
- Literal cases: `file://`, `gopher://`, `http://169.254.169.254`, `http://[::ffff:169.254.0.1]`,
  `http://0.0.0.0`, `http://224.0.0.1`, `http://192.0.0.192` all rejected pre-fetch;
  `http://192.168.1.10:8096`, `http://127.0.0.1:8096`, `http://100.64.0.1:8096` allowed.
- URL with embedded credentials rejected (new), and `servers.url` after a successful setup equals the
  canonical origin with no credentials, no query and no fragment.

**Single-owner constraint (SEC-04)**
- Index existence asserted after a clean startup by querying `pg_indexes` (new).
- A database seeded with two owner rows fails the migration with the actionable message and the
  server does not start (new; this replaces revision 1's "boots with a warning" case, which is no
  longer the intended behavior).
- Two parallel `/emby/setup` requests, and one `/emby/setup` against one `/sign-up/username`, yield
  exactly one owner; the loser gets 403; no orphan `servers` or `auth_accounts` rows.

**Plex paths (SEC-05)**
- A race loser on `/plex/check-pin` and on `/plex/connect` gets 403, not 500 (new).
- A failed user insert at `/plex/connect` leaves no newly created `servers` row and does not overwrite
  an existing row's token (new).

**Compensation and retry (SEC-06)**
- Fault injection at the server insert, the link insert and the session create: the instance is
  unclaimed or in the recovery state as appropriate, and a retry succeeds.
- A compensation failure that leaves a `servers` row logs `INSTANCE REQUIRES MANUAL RECOVERY`, and a
  retry with the claim code adopts that row rather than returning a conflict (new).

**Bounds (SEC-07)**
- The sixth request within a minute from one IP is rate-limited before any outbound call (new).
- The third concurrent request returns `BUSY` with no outbound call (new).
- A probe against a host that never answers is abandoned at `SETUP_PROBE_TIMEOUT_MS`, and the whole
  request at `SETUP_TOTAL_BUDGET_MS`.

**Secrets (SEC-10)**
- Logs free of `apiKey` and `password` across the whole flow, including the failure paths, asserted by
  capturing the logger (new).

**Continuity**
- Claim code enabled means enforced before any outbound request (the mocked fetch is never called on a
  wrong code).
- Post-setup login continuity: `/emby/login` with the same Emby credentials succeeds and matches the
  bound identity, while a different Emby admin on the same server is denied (existing
  `decideEmbyOwnerLogin` behavior, now seeded by setup's bind).
- `promote-owner` on an instance that already has an owner refuses (new).

## 17. Claim register

Numeric and semantic claims in this document, marked per the repo's counted-versus-estimated rule.

**Counted** (re-derived from the worktree on this branch during revision 2, not copied from
revision 1):

- `assertSignupAllowed()` tests only the owner row: `authGuards.ts:9-16`.
- `resolveConfiguredEmbyServerUrl()` has no `ORDER BY`: `embyPlugin.ts:85-92`.
- `fetchJson` passes no `redirect` option: `http.ts:118-129`.
- `HttpClientError`'s default message embeds status and status text: `http.ts:31-33`, interpolated
  into client-facing text at `emby/client.ts:169` and `232`.
- `ssrf.ts` never resolves hostnames and says so: `ssrf.ts:57-63`.
- `createPartialIndexes()` has exactly one caller, inside a warn-and-continue catch:
  `timescale.ts:662-723` and `1734-1740`.
- Migrations rethrow and abort startup: `index.ts:607-615`.
- Direct owner inserts on the Plex paths: `plexPlugin.ts:351-360` and `487-496`; server write precedes
  user insert at `/plex/connect`: `453-483` before `487-496`.
- Better-auth rate limiting is enabled by an explicit typed option defaulting to `true`:
  `auth.ts:130-146` and `232-237`. No `customRules` exist anywhere in `apps/server/src`. The Fastify
  global limiter is `max: 1000` per minute: `index.ts:312-315`.
- The admin plugin is registered with `adminRoles: ['owner']`: `auth.ts:285`.
- `reset-password.ts` requires an existing owner row: `reset-password.ts:38-56`. `cli.ts` exposes five
  commands, none of which promotes a user to owner: `cli.ts:111-123`.
- `/setup/status` already publishes `needsSetup`, `hasServers`, `hasPasswordAuth`:
  `routes/setup.ts:37-44`.
- `assertSafeProbeUrl` call sites across `apps/server/src` (`*.ts`): `ssrf.ts` (definition), its test,
  `services/ombi.ts:303`, `services/seerr.ts:373`, `services/mediaServer/plex/client.ts:629`,
  `services/mediaServer/plex/connectionTest.ts:65`. `EmbyClient` has none.
- CGNAT `100.64.0.0/10` is explicitly allowed by the existing tests: `ssrf.test.ts:84-88`.

**Inferred, unverified** (each names what would verify it):

- Emby user access tokens are revocable in ways dedicated API keys are not (section 5). Verify against
  a live Emby 4.9 by revoking sessions and observing which credential survives.
- undici's `Agent` forwards a custom `connect.lookup` to `net`/`tls` in the version bundled with this
  repo's Node runtime (8.2, step 3). Verify with a build-time spike; the fallback is stated inline.
- better-auth 1.6.23 spells the per-path rule `rateLimit.customRules['<path>'] = { window, max }`
  (section 9). Verify against the installed package's types; the fallback is a Fastify route rule.
- `CREATE UNIQUE INDEX ... ON users (role) WHERE role = 'owner'` enforces at most one owner row
  (7.1). Confirmed by the reviewer as unambiguously valid; verified for real by the integration case in
  section 16 that attempts two concurrent owner inserts. Revision 1's `((true))` form was an
  **unlabelled** inference and is withdrawn.
- Alibaba Cloud's metadata endpoint is `100.100.100.200` and therefore inside the allowed CGNAT range
  (8.3). Verify against Alibaba's documentation before treating the carve-out as complete.

**Estimated:** none. No sizing figure in this document is an estimate; the two numeric limits in
section 9 are chosen constants, not measurements, and the review proposed the 5-per-minute figure.

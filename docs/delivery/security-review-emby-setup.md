# Security Review: Emby-Native First-Run Setup (design)

**Verdict:** NO-GO as written (4 High, 4 Medium, 3 Low)
**Reviewed artifacts:** `docs/architecture/emby-native-setup.md`, `docs/architecture/adr/0009-emby-native-first-run-setup.md` (pre-revision)
**Reviewer:** security-reviewer (read-only; this file was saved by the software-architect on the reviewer's behalf)
**Date:** 2026-07-29
**Branch:** `feat/emby-native-setup`

> This is the review as delivered. The architect's response lives in the revised design
> (`docs/architecture/emby-native-setup.md`) and ADR-0009. Where the architect re-derived a
> code fact and it disagreed with the review, that is recorded in the addendum at the end
> rather than by silently editing the reviewer's text.

## What the review endorsed

- A separate endpoint rather than a dual-mode `/emby/login`.
- The refined invariant (client URLs accepted by exactly one endpoint, only while unclaimed).
- Two credentials for two jobs (admin API key as the polling credential, user password for identity).
- Compensation instead of a raw transaction.
- Closing SR-02 at the database rather than in application code.
- The habit of labelling inferred-unverified statements. Two of the three such labels turned out
  load-bearing and one was simply false, which is exactly what the labels are for.

## Findings

### SEC-01 (High) - the gate is "no owner row", not "fresh instance"

`assertSignupAllowed()` only asks whether a `role='owner'` row exists. An instance can be ownerless
yet fully populated: a support incident, a partial restore, a merge or cleanup that removed the
owner, or the better-auth admin plugin's user-removal endpoint. An attacker reaching such an
instance posts their own Emby URL, passes verify-admin trivially on their own box, becomes owner of
a populated deployment, and can then use the existing `pg_dump`-based owner backup export to pull
the whole database including the real operator's plaintext `servers.token` and Plex tokens. Local
signup shares the claim half of this but cannot supply a server URL.

Remediation: gate on *unclaimed* (no `servers`, no `auth_accounts`, no `users` rows at all), not
merely ownerless. When state exists but no owner does, either refuse with an operator-facing
recovery message or fall back to server-side URL resolution as `/emby/login` does. Require the claim
code unconditionally in that state. Emit a loud, persistent operator signal when an initialized
instance goes ownerless.

### SEC-02 (High) - a second `emby` server row makes login nondeterministic

`resolveConfiguredEmbyServerUrl()` (`embyPlugin.ts:84-92`) is `select ... where type='emby' limit(1)`
with no `ORDER BY`. Two `emby` rows means two authentication authorities and the choice can change
between calls. The design's guard against a second row is a URL-equality check, which by
construction only fires when the URLs match, that is, only in the harmless case. Combined with
SEC-01 this reaches the exact auth bypass the `embyPlugin.ts` NOTE exists to prevent, through the
untouched endpoint.

Remediation: make resolution deterministic and preferably fail closed when more than one `emby` row
exists. Never insert a second `emby` row from setup (adopt the existing one or refuse). Consider a
partial unique index on `servers` if single-Emby is the product rule. Whether multiple Emby servers
are supported is a product question: flag it, and design both ways if it cannot be settled.

### SEC-03 (High) - the SSRF control does not survive a deliberate attacker, and the error path leaks status

Three gaps:

(a) `fetchJson` sets no `redirect` option, so Node follows redirects. An attacker's host answers
`302 Location: http://169.254.169.254/...`, and a `307` preserves method and body, turning the
authenticate step into an arbitrary internal JSON POST.

(b) `ssrf.ts` inspects IP literals only and never resolves hostnames, so a DNS name pointing at a
denied address walks straight through. Its own doc comment says "defense-in-depth only", while the
design's section 7 promoted it to control number one.

(c) The 503 body carries the upstream status and status text (`client.ts:169` into `http.ts:31-33`),
which with distinct status mapping and 10 s timeouts is a usable internal port and service scanner.

Remediation: `redirect: 'manual'` with 3xx treated as hard failure; resolve the hostname and
validate every resolved address, pinning or re-validating on connect; extend the deny list (metadata
addresses, `0.0.0.0/8`, multicast); return a fixed generic client-facing string and log detail
server-side only; add verification cases for redirect-to-metadata and DNS-to-denied-address.

### SEC-04 (High) - the SR-02 index may silently never exist

The design placed `users_single_owner` in `createPartialIndexes()`, whose only caller wraps the whole
function in a catch that logs "Partial indexes: some may already exist". A failure is therefore
downgraded to a benign-looking warning, and every index declared after the failing statement is
skipped. That is a security constraint established by a best-effort path with no verification.

Also, `ON users ((true))` is asserted as fact without a verification note. The reviewer could not
confirm that construct and points out that
`CREATE UNIQUE INDEX users_single_owner ON users (role) WHERE role = 'owner'` is unambiguously valid
and semantically identical.

Remediation: create it in a drizzle migration (migrations abort startup on failure, the correct mode
for an auth-integrity constraint). If it must stay in `timescale.ts`, isolate it, run it first, and
verify existence via `pg_indexes` afterwards, surfacing absence at error level. Use the `(role)` form.

### SEC-05 (Medium) - "every signup path funnels through the `user.create` hook" is false

`plexPlugin.ts:351-360` and `487-496` insert owner rows directly with drizzle, so the hook never runs
for them. The DB index still enforces single-owner, which is the important part, but a race loser on
the Plex paths gets a raw unique-violation surfaced as a 500, and at `/plex/connect` the `servers`
row is already inserted (or an existing token overwritten) before the user insert fails, leaving an
orphan row with no compensation.

Remediation: map the violation to 403 at both Plex sites too; reorder `/plex/connect` so the
contended user insert precedes the server write; correct the sentence, since the funnel is the
database, not the hook chain.

### SEC-06 (Medium) - the duplicate-URL 409 can make setup un-retryable

If compensation's server-row delete is the step that fails, a leftover row keeps the URL and every
retry hits the design's own 409 permanently.

Remediation: adopt or update the existing row when the URL matches and the instance is ownerless
(this composes with SEC-02); log compensation failures with a greppable "instance requires manual
recovery" marker naming the real recovery tool (`pnpm reset-password`,
`apps/server/scripts/reset-password.ts`).

### SEC-07 (Medium) - rate limiting is enabled but unbounded for this path

Resolved from code: the limiter is explicitly enabled (`auth.ts:130-146`), so the design's
inferred-unverified note is half-answered. But there are no `customRules` anywhere, so only the
global default applies. Each request can occupy up to four sequential 10 s outbound waits with no
concurrency cap: a scanning budget, a socket-exhaustion lever, and a password-guessing relay against
the operator's Emby.

Remediation: a mandatory `customRules` entry for the setup path (about 5/min/IP) plus a server-side
constant capping concurrent in-flight setup probes. Both must be constants, never derived from the
request.

### SEC-08 (Medium) - see the factual corrections below

The design's claim that pre-auth outbound probing is a new capability is wrong, and the "does not
worsen SR-03" claim is unqualified. Both are listed under factual corrections rather than as
separate remediations.

### SEC-09 (Low) - URL userinfo, query and fragment

Reject URLs carrying userinfo, query or fragment, and canonicalize what is stored. Credentials in a
URL currently persist into `servers.url` and into error strings.

### SEC-10 (Low) - "never log secrets" is unbacked

Back the requirement with an actual test plus logger redaction paths.

### SEC-11 (Low) - T7's uniform-403 wording is inexact

The wording stops being exact once the claim code is enabled.

## Factual errors the review required the design to correct

1. **T8's mitigation does not exist.** The design wrote that the owner "can set a local password
   later from settings (inferred - unverified)". There is no HTTP surface for that, only the CLI
   `pnpm reset-password`. That assumption was load-bearing for accepting the Emby-outage lockout.
   Either propose an in-app set-password endpoint in this increment, or state plainly that recovery
   is CLI-only, warn on the setup screen, and put the exact command in the runbook. This is an owner
   decision and must be presented as one.
2. **Pre-auth outbound probing is not new.** `/plex/connect` (`plexPlugin.ts:399-446`) already takes a
   client-supplied `serverUri` on an unauthenticated pre-claim endpoint. The new endpoint is a
   better-behaved instance of an existing capability. Correcting this strengthens the design's
   position, and fixing the class properly means fixing that path too.
3. **"Does not worsen SR-03"** holds for a genuinely fresh instance but not for an
   ownerless-but-populated one. Once SEC-01 and SEC-02 are fixed the claim becomes accurate, and the
   design should say so explicitly rather than leaving it unqualified.
4. **Claim-code default-on** is agreed and is close to a prerequisite for this feature. One detail
   the design did not cover: an auto-generated code must persist across restarts (the `settings`
   table is the obvious home) or every container restart invalidates the code the operator copied
   from the log.

## Owner decisions the reviewer wants collected in one place

1. Claim code default-on, its persistence across restarts, and whether it is single-use.
2. In-app set-password surface in this increment, or accept CLI-only recovery and document it.
3. Is more than one Emby server a supported configuration?
4. Accept or reject the residual SSRF exposure after mitigation. Loopback and RFC1918 must stay
   allowed for self-hosted, so a pre-claim internal probe still exists. The reviewer judges this
   acceptable provided the claim code is on by default.
5. Fix `/plex/connect`'s unguarded probe in this increment, or track it separately.

## Additional verification cases requested

- Redirect-to-metadata rejected.
- Hostname resolving to a denied address rejected.
- Error responses free of upstream status text.
- Index existence asserted after a clean startup.
- URL with embedded credentials rejected.
- Logs free of `apiKey` and `password`.
- A second `emby` row impossible, or `/emby/login` failing closed.
- Setup refused on an ownerless instance holding servers or users.

---

## Addendum: architect verification notes (added when saving this file)

Per the coordinator's standing rule that a review finding is a claim to verify rather than a fact to
action, the architect re-derived each code-level claim in this review against the worktree. All were
confirmed except one, and one of the architect's own earlier claims was found wrong.

**Confirmed by re-derivation** (file and line as of this branch):

- SEC-01: `assertSignupAllowed()` checks only `getOwnerUser()` (`authGuards.ts:9-16`). The admin
  plugin is registered with `adminRoles: ['owner']` (`auth.ts:285`), so an admin user-removal
  surface exists.
- SEC-02: `resolveConfiguredEmbyServerUrl()` is `where(eq(servers.type,'emby')).limit(1)` with no
  ordering (`embyPlugin.ts:85-92`).
- SEC-03: `fetchJson` passes no `redirect` option (`http.ts:118-129`); `ssrf.ts` never resolves
  hostnames and says so in its own comment (`ssrf.ts:57-63`); `HttpClientError`'s default message is
  `"<service> request failed: <status> <statusText>"` (`http.ts:31-33`) and `verifyServerAdmin`
  interpolates it into the client-facing message (`emby/client.ts:169, 232`).
- SEC-04: `createPartialIndexes()` (`timescale.ts:662-723`) is called inside a try/catch that logs
  `console.warn` and pushes "Partial indexes: some may already exist" (`timescale.ts:1734-1740`).
  Drizzle migrations, by contrast, rethrow and abort startup (`index.ts:607-615`), and the repo
  already has the precedent of a unique index created by migration (`users_login_username_unique`,
  referenced from `db/__tests__/loginUsernameCollision.integration.test.ts:26-30`).
- SEC-05: both direct owner inserts confirmed (`plexPlugin.ts:351-360`, `487-496`), and at
  `/plex/connect` the `servers` insert or token update (`plexPlugin.ts:453-483`) precedes the user
  insert (`487-496`).
- SEC-07: `rateLimit: { enabled: rateLimitEnabled, storage: 'secondary-storage' }` with the default
  `true` (`auth.ts:146, 232-237`); no `customRules` anywhere in `apps/server/src`. The Fastify global
  limiter is `max: 1000, timeWindow: '1 minute'` (`index.ts:312-315`), which is not a meaningful
  bound for this path.

**One reviewer claim corrected.** The review states that `/plex/connect` probes the client-supplied
`serverUri` "with no SSRF check at all". `PlexClient.verifyServerAdmin` does call
`assertSafeProbeUrl(url)` as its first action (`plex/client.ts:628-637`), and `/plex/connect` calls
`verifyServerAdmin` before constructing a client (`plexPlugin.ts:440-449`). So the path is guarded by
the same literal-only check used everywhere else. The substance of the finding survives: that check
does not resolve hostnames, does not block redirects, and is not re-validated on connect, so
`/plex/connect` carries the same residual exposure that SEC-03 raises against the new endpoint. It is
an under-guarded pre-auth probe, not an unguarded one. Owner decision 5 is restated on that basis.

**One architect claim corrected.** The pre-revision design asserted, marked "counted", that a grep
for `assertSafeProbeUrl` across `apps/server/src` hits only `ssrf.ts`, its test, `ombi.ts` and
`seerr.ts`. That is wrong. It also hits `services/mediaServer/plex/client.ts:629` and
`services/mediaServer/plex/connectionTest.ts:65`. The corrected statement, which is what the design
actually needed, is narrower: `EmbyClient.verifyServerAdmin` and `EmbyClient.authenticate` perform no
SSRF check (`emby/client.ts:94-235`), so `POST /servers` with `type: 'emby'` or `'jellyfin'` is
unguarded while `type: 'plex'` is guarded inside the Plex client. A counted claim that was counted
over the wrong scope is still a wrong claim, and it is corrected in the revised design.

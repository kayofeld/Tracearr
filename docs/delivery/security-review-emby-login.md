# Security review — Emby login diagnosis

**Reviewed:** `0802dbca` on `feat/emby-login-ux` (single commit off `main` @ `f0e62348`).
**Reviewer:** `security-reviewer` (read-only; report saved by the coordinator).
**Verdict:** CONDITIONAL NO-GO — two blockers, one engineer-side and one owner decision.

Counts: Critical 0, High 2, Medium 2, Low 3, Info 3.

| ID  | Title                                                               | Severity | Owner    | Outcome                                      |
| --- | ------------------------------------------------------------------- | -------- | -------- | -------------------------------------------- |
| F1  | Oracle enumerates all Emby users, not just admins                   | High     | Owner    | Narrowed to the linked owner account         |
| F2  | Pre-auth Emby lockout DoS, now with success confirmation            | High     | Owner    | Lockout reason removed entirely              |
| F3  | Rate limit bypassable via `X-Forwarded-For` when `TRUST_PROXY=true` | Medium   | Engineer | Fixing                                       |
| F4  | Rate limit fails open silently if the path literal drifts           | Medium   | Engineer | Fixing (shared constant + real binding test) |
| F5  | "Never slower" comment is false; admin-key-presence timing signal   | Low      | Engineer | Comment corrected                            |
| F6  | No size clamp on the diagnosis response body                        | Low      | Engineer | Accepted (pre-existing house pattern)        |
| F7  | Anonymous error leaks the configured Emby URL                       | Low      | Engineer | Fixing                                       |
| F8  | `embyAccountLinked` confirms the oracle is armed                    | Info     | —        | Accepted                                     |
| F9  | Credential handling verified clean                                  | Info     | —        | No action                                    |
| F10 | Login page disclosure is presentational only                        | Info     | —        | No action                                    |

## F1 (High) — the oracle covered every Emby account

The diagnosis ran at `embyPlugin.ts:205`, **before** the administrator check at `:211`, and matched against the
unfiltered `/Users` list with no admin filter (`client.ts:291-295`). An anonymous caller could therefore
determine, for any guessed name, whether any account existed on the owner's Emby server, and whether it was
disabled or locked out — family and friends included, not only administrators.

This was broader than the trade-off the owner accepted. The coordinator had briefed the reviewer that
enumeration "mainly confirms admin usernames"; the reviewer checked and found the code contradicted it.
Recorded because the owner's original decision rested on that incorrect framing.

**Resolution (owner):** diagnose only the Emby account already bound to the owner in `auth_accounts`, looked up
by its stored `accountId` rather than by scanning `/Users`. Any other username returns the pre-existing generic
message with no outbound call. This removes the enumeration surface entirely rather than filtering it, and it
moots the case-insensitive first-match defect the code review raised, since matching is by id, not by name.

## F2 (High) — lockout reporting confirmed a DoS against the owner's own Emby

Every request to this unauthenticated endpoint forwards a real credential attempt to the owner's Emby server,
which counts it toward Emby's lockout. That exposure predates this change. What the change added was the
feedback channel: `account_locked_out` told an attacker their attack had landed, and kept confirming it. The
rate limit was not chosen to sit below any Emby lockout threshold, and Emby's threshold is configurable and
commonly single-digit.

**Resolution (owner):** the lockout reason is removed from the endpoint and from the shared union. A locked-out
account falls back to password-rejected. This also removes threshold arithmetic whose boundary semantics could
not be verified without tripping a real lockout on a live server.

## F3 (Medium, blocking) — the mitigation did not hold behind a reverse proxy

`index.ts:256` sets `trustProxy: process.env.TRUST_PROXY === 'true'`. Boolean `true` trusts every hop, so
`request.ip` becomes the leftmost client-supplied `X-Forwarded-For` value, which is stamped into the header
better-auth keys its rate limiting on. An attacker rotating that header lands in a fresh bucket per request and
the limit disappears. The Fastify global limiter is explicitly disabled on the auth mount (`index.ts:425`), so
there is no second layer. `TRUST_PROXY=true` is what the README instructs reverse-proxy users to set, and this
weakens the existing sign-in limits too, not only this feature.

**Not live on the owner's instance:** `TRUST_PROXY` is unset there, so `trustProxy` is false and the limit binds
correctly today. It would become live on any proxied deployment.

The reviewer verified the rest of the bypass surface is closed: plugin rules override the built-in special
rules and are applied before routing; path normalization strips `basePath` and trailing slashes; the IP header
is `set` rather than appended so an inbound copy cannot survive; window and max are fixed module constants; and
the Redis counter is atomic.

**On adequacy, asked directly:** even when it binds, 5/60s per IP slows bulk harvesting rather than preventing
enumeration — a twenty-name list falls in four minutes from one IP. As an anti-password-guessing control it is
reasonable. It was not a sufficient mitigation for the oracle, which is why the oracle itself was narrowed.

## F4 (Medium) — a security control keyed on a duplicated string literal

The endpoint path existed as three independent literals (`createAuthEndpoint`, the rate-limit `pathMatcher`,
and the frontend fetch). A rename would silently unbind the matcher, better-auth would fall through to the
lenient default with no error or log, and — with the Fastify limiter off on that mount — the endpoint would
become effectively unlimited. The existing test asserted the matcher against its own hard-coded copy of the
literal, so it would still pass after a rename: it verified the rule's shape, never that the rule bound to the
real mounted route. The repo already had the correct pattern in `SIGN_UP_USERNAME_PATH`.

## Verified clean

- **Credential handling (F9).** The admin key travels in a request header, never a query string, so it cannot
  reach `HttpClientError.url` or a log line. Failures are swallowed before reaching the response. The submitted
  password is never passed to the diagnosis. A missing or invalid key degrades to the same generic message the
  endpoint returned before the feature existed.
- **Fail-safe behaviour.** The 3s timeout is a module constant passed to `AbortSignal.timeout`, covering
  connection, response and body read, so a hostile or hanging Emby cannot stall the login path.
- **Login page (F10).** Presentational only. `localLoginEnabled` is untouched, the local block stays mounted
  inside the disclosure, and if `/setup/status` fails the page falls back to showing the local form. No lockout.

## Accepted / no action

- **F6** — no byte cap on the diagnosis response body. The URL is server-side configuration rather than client
  input, and the same unbounded-body pattern exists on every call in the client, so this is a pre-existing house
  pattern rather than a regression. Worth addressing repo-wide if `fetchJson` is ever revisited.
- **F8** — `embyAccountLinked` on the unauthenticated status endpoint adds a marginal signal that the Emby path
  is live. The endpoint already discloses more than this, and the query correctly requires `role = 'owner'`.

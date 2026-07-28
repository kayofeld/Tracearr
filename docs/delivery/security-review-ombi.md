# Security review — Ombi connector (`feat/ombi-connector`)

Reviewer: `security-reviewer` (independent, read-only) · 2026-07-28
Commits: db14ab9c, 14f4e542, 0ba97ac6, 1dee0ffe

**Verdict: GO for homelab deployment.** 0 Critical · 0 High · 1 Medium (decision) · 4 Low · 3 Info.
Nothing must be fixed before deploy. SEC-01 needs an explicit owner decision recorded.

| ID      | Finding                                                                                         | Sev               | Location                                     | Disposition                                                   |
| ------- | ----------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------- | ------------------------------------------------------------- |
| SEC-01  | Ombi admin API key plaintext in DB + backups                                                    | Medium (decision) | `services/settings.ts:33-34`, ADR 0005       | Owner accepted-risk (below)                                   |
| SEC-02  | Redirects followed; `ApiKey` header survives cross-origin redirect                              | Low               | `services/ombi.ts:264`                       | Fix                                                           |
| SEC-03  | Timeout cleared before body read; unbounded body buffering                                      | Low               | `services/ombi.ts:268,288`                   | Fix                                                           |
| SEC-04  | Sync error strings (incl. Ombi URL) broadcast to all authenticated WS clients                   | Low               | `index.ts:1033-1035`, `ombiSyncQueue.ts:430` | Fix (cheap)                                                   |
| SEC-05  | No length caps on external strings vs DB varchar → one oversized field fails a whole sync phase | Low               | `services/ombi.ts:59-111`, migration 0067    | Fix (real risk on live data)                                  |
| SEC-06  | TOCTOU in manual-sync enqueue (harmless, worker concurrency 1)                                  | Info              | `ombiSyncQueue.ts:498-507`                   | Accept                                                        |
| SEC-07  | `redis.keys()` blocking scan in cache invalidation                                              | Info              | `ombiSyncQueue.ts:61`                        | Accept (matches librarySync precedent)                        |
| PRIV-01 | Requester identity + "wasted GB" visible to any authenticated user                              | Info              | `stale.ts:505-515`, `stats/requesters.ts`    | Owner accepted; revisit if `allowGuestAccess` is ever enabled |

## Verified good (checked against code, not assumed)

- **Authorization:** all six `/ombi/*` routes carry `requireOwner`; mapping PUT/DELETE verify the target `userId` exists (no IDOR); `resolveServerIds` honored and the resolved-server segment is embedded in the Redis cache key, so a non-owner cannot read an owner's cached payload.
- **SSRF:** `assertSafeProbeUrl()` runs in the `OmbiService` constructor, and _every_ request path constructs the service (test-connection + sync). No path fetches without it. Loopback/RFC1918 allowance is deliberate (needed for `localhost:5420`); link-local blocked incl. the IPv4-mapped-IPv6 bypass.
- **Key leakage (empirical):** the key travels only in the `ApiKey` header, never into error text; auth/invalid-response messages are static; retry logs and `classifyError` pass through `redact()`. It cannot reach `ombiSyncStatus.lastError`, the WS payload, or any status/mappings/stats/purge response. Returned only by owner-gated `GET/PATCH /settings`.
- **PII:** `email` and `providerUserId` are parsed then dropped before persistence — no such columns exist. Skip logs print record id + Zod issue only, never payload values.
- **Injection:** every dynamic value goes through drizzle's parameterized `sql` template. `sql.raw()` appears only on hardcoded identifiers and a whitelist-mapped sort column. No external string reaches `sql.raw`.
- **Prune safety (ADR 0004 claim verified TRUE):** `allowPrune = skipped === 0`, only after a successful fetch; upsert+prune share one transaction per media type. A partial or failed fetch cannot delete rows.
- **Purge:** 409-while-configured guard present, transactional, owner-only, plus a destructive-confirm dialog.

## SEC-01 — the plaintext API key, in plain terms

The key is **full-admin** on an Ombi instance that is publicly reachable, and plaintext storage means it lands in every Postgres dump and every Tracearr backup. The exposure plaintext _adds_ is exactly one scenario: someone reads a backup without having live DB access (anyone with live DB or host access already owns everything, because any at-rest key must live next to the app).

Options assessed for this deployment:

1. **Leave as-is (ADR 0005).** Consistent with `tautulliApiKey`, `telegramBotToken`, `pushoverApiToken`, `ntfyAuthToken` — four live credentials already plaintext in the same table. Encrypting only the Ombi key would be security theater.
2. **Env var / root-owned file.** Removes it from the DB and backups, but breaks UI-driven configuration (a core requirement) and diverges from every other integration. Not worth it for one key.
3. **Encryption at rest, key in `ENCRYPTION_KEY`.** This _does_ defeat the backup-leak scenario, because the decryption key lives in the host env — a different trust domain from a DB dump. But done properly it means migrating all five settings secrets plus rotation handling, i.e. a repo-wide decision, not an Ombi patch.
4. **Scope-limit the Ombi key.** Not available — Ombi v4 has a single global full-access API key.

**Recommendation: option 1, with compensations** — (a) treat Tracearr backups/DB dumps as secret material (encrypt or restrict permissions; already warranted by the four pre-existing tokens), (b) runbook note "rotate the Ombi API key if a backup leaks", (c) backlog option 3 as a repo-wide item per ADR 0005's own follow-up.

## Threat model (condensed)

Assets: Ombi admin key; requester identity data; mirror integrity. Main trust boundary crossed: untrusted Ombi responses (well mitigated by Zod + content-type check + prune suppression). Top threats: key exfiltration via backups (SEC-01); malicious/compromised Ombi responses (SEC-02/03/05); info disclosure to lesser-privileged users (SEC-04/PRIV-01).

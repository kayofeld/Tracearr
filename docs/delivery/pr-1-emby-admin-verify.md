# PR 1 — ready to open (Paul opens it; do not auto-open)

**From:** `kayofeld:fix/emby-admin-verify-robustness` → **To:** `connorgallopo:main`
**Open at:** https://github.com/connorgallopo/Tracearr/compare/main...kayofeld:Tracearr:fix/emby-admin-verify-robustness

**Title:**

```
Harden Emby admin verification: distinguish transient failures from auth rejections
```

**Body (paste below):**

```markdown
## Summary

`EmbyClient.verifyServerAdmin` returned a bare boolean and swallowed every error as `false`, so a transient network error or 5xx on the `/Auth/Keys` probe reported a legitimate admin API key as "not admin" and blocked adding the server. The Jellyfin equivalent was already hardened; this brings Emby to parity: a structured `{ success } | { success: false, code, message }` result, a pre-flight connectivity probe (`/System/Info/Public`), and error classification via HTTP status (401 → invalid key, 403 → not admin, transient/other → connection failed). Callers now surface the right HTTP status (503/401/403) with a specific message instead of a generic 403.

## Type of Change

- [x] Bug fix
- [ ] New feature
- [ ] Documentation
- [ ] Refactor
- [ ] Breaking change

## Related Issue

None filed — found while reviewing Emby integration parity with Jellyfin.

## Changes

- `EmbyClient.verifyServerAdmin` returns a structured result mirroring `JellyfinClient.verifyServerAdmin` (`AdminVerifyError` codes: `CONNECTION_FAILED` / `INVALID_KEY` / `NOT_ADMIN`); errors are classified by `HttpClientError.statusCode` instead of being swallowed.
- The three callers (`routes/auth/emby.ts` connect-api-key, `routes/servers.ts` server add + URL change) map failure codes to 503/401/403, matching the existing Jellyfin caller behavior.
- Registered `src/services/mediaServer/emby/__tests__/*.test.ts` in `vitest.unit.config.ts` — the glob was missing, so tests in that folder never ran in the unit suite.
- New `emby/__tests__/client.test.ts` (12 tests): user-token/admin-key/non-admin/invalid-key paths, the transient-failure regression, malformed-body fail-closed, proxy 502 classification.
- Comment fix verified against a live Emby 4.9.5 server: `/Users/Me` with an API key returns **500** on Emby (Jellyfin returns 400); the fall-through logic handles both, and the comment now records the observed statuses.

## Testing

- [x] Added/updated unit tests
- [x] Ran test suite locally (`pnpm test:unit`)
- [x] Tested manually

Manual testing: verified endpoint semantics against a live Emby 4.9.5 instance — valid admin API key: `/Users/Me` → 500, `/Auth/Keys` → 200 (verified admin); invalid key: 401 on both (classified `INVALID_KEY`). Local: 1403 unit tests pass, 35 server route tests pass, `tsc --noEmit` clean, `eslint` clean.

## AI Disclosure

- [x] AI tools were used significantly in writing this code

Implementation and tests written with Claude Code, mirroring the existing hardened Jellyfin implementation; independently security-reviewed (no fail-open path: unknown errors and malformed bodies classify as failure, never success) and validated against a real Emby 4.9.5 server.

## Checklist

- [x] Code follows project style (ran `pnpm lint` and `pnpm format`)
- [x] Self-reviewed
- [x] No new warnings from `pnpm typecheck`
- [x] Tests pass locally
```

**Reviewer notes (not part of the PR body):** the security review left two optional, out-of-scope observations we chose not to bundle: (a) the shared `buildStaticAuthHeader` interpolates the token unescaped into the MediaBrowser header (pre-existing, affects all callers; a `"` in a key breaks the header grammar but fails closed); (b) `X-Emby-Authorization` being a custom header survives cross-origin redirects where Jellyfin's `Authorization` would be stripped by undici (pre-existing class for every Emby call). Both are candidates for a separate upstream issue/PR.

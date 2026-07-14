# Auth Migration Rollout Checklist

Rollout notes for the Better Auth migration (better-auth 1.6.23, pinned). This file is the source for the release notes and the release-day steps. The public docs site lives in a separate repository and is updated as a release step (checklist below).

## Release notes (draft)

These items go at the top of the release notes, in this order.

1. **Jellyfin login is removed.** Signing in to Tracearr with Jellyfin credentials is no longer supported. Jellyfin and Emby servers are still fully supported for monitoring; only the login method is gone. Installs that only ever logged in via Jellyfin recover with either:
   - `docker exec tracearr node apps/server/dist/scripts/cli.js reset-password` (works even when the account has no existing password), or
   - Plex login, when a Plex account is linked.
2. **All web users must log in once after upgrading.** Legacy web sessions are not carried over.
3. **Mobile devices paired after upgrading use a 90-day rolling session** (any use within 90 days extends it, since the refresh token outlives and re-mints the underlying 30-day session); a device idle for more than 90 days re-pairs. Devices paired before the upgrade keep working on their existing tokens until they are re-paired; nothing expires them at 90 days.

## Environment variables

- `BETTER_AUTH_SECRET` (optional, recommended to set explicitly). When unset it is derived deterministically from `JWT_SECRET` via HKDF-SHA256, so upgrading installs need no new env var. Every instance in a multi-instance deployment must share the same value, or the same `JWT_SECRET` when relying on derivation. Boot fails only when neither `BETTER_AUTH_SECRET` nor `JWT_SECRET` is set.
- `JWT_SECRET` remains required. It backs the mobile legacy-token shim and is the derivation input for `BETTER_AUTH_SECRET`. Its retirement is deferred to a later cleanup release.
- `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (optional). OIDC login is enabled only when all three are set. `OIDC_PROVIDER_NAME` labels the login button (default: SSO).
- Reverse proxy: behind an HTTPS reverse proxy, logins work as long as the proxy preserves the Host header, forwards `x-forwarded-host`, or `CORS_ORIGIN` is set to the public URL. Forward `x-forwarded-proto` so session cookies carry the Secure attribute over HTTPS. `TRUST_PROXY=true` enables client IP resolution from `X-Forwarded-*` headers (recommended behind a proxy so sign-in rate limits count per client instead of per proxy).

## Migrations

Run `db:migrate` before starting the new version. The Better Auth chain, in order:

- `0060_amused_lila_cheney.sql`: creates the Better Auth tables (`auth_accounts`, `auth_sessions`, `auth_verifications`, plus new `users` and `mobile_sessions` columns)
- `0061_better_auth_backfill.sql`: backfills `email_verified`, normalized usernames, and credential/plex account rows from existing users (idempotent, safe to re-run)
- `0062_drop_primary_auth_method_setting.sql`: deletes the retired Jellyfin auth settings row

## Upgrade verification (per install)

- Owner logs in with the pre-migration password (bcrypt hash carried into the account row by the backfill)
- Plex login works when a Plex account is linked
- Previously paired mobile devices keep working without re-pairing (legacy token shim)
- A fresh mobile pairing works

## Docs repository checklist (separate repo, release step)

The public docs live at `/home/cgallopo/dev/personal/tracearr-docs` (Next.js App Router + Nextra, docs.tracearr.com), not in this repository. Every fact below was verified against this repo's code as cited; the release-notes copy in the section above is ready to adapt. Site conventions: each page is `app/<route>/page.mdx` with two-key YAML frontmatter (`title`, `description`), navigation is ordered by `_meta.ts` files, and `app/sitemap.ts` enumerates every route manually, so any new page needs a sitemap entry. Renamed or moved pages need a redirect in `next.config.ts`.

1. `app/configuration/environment/page.mdx` (canonical env reference)
   - Remove the `SESSION_SECRET` row from the Optional Variables table. That variable does not exist in the server codebase (no matches in `apps/server/src` or `.env.example`).
   - Add `JWT_SECRET` (required) and `COOKIE_SECRET` (required) rows; today only the installation pages document them. Note on `JWT_SECRET`: still required after the Better Auth migration because it backs the mobile legacy-token shim and is the derivation input for `BETTER_AUTH_SECRET`; retirement is deferred to a later cleanup release (`apps/server/src/plugins/auth.ts`, `apps/server/src/lib/env.ts`).
   - Add `BETTER_AUTH_SECRET` (optional): recommended to set explicitly; when unset it is derived from `JWT_SECRET` via HKDF-SHA256; boot fails only when neither is set; multi-instance deployments must share the value or the same `JWT_SECRET` (`apps/server/src/lib/env.ts`).
   - Add `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`: OIDC login is enabled only when all three are set (`oidcConfigured` in `apps/server/src/lib/auth.ts`). Add `OIDC_PROVIDER_NAME`: label for the login button, default "SSO" (`apps/server/src/routes/setup.ts`).
   - Add `TRUST_PROXY`: `true` enables client IP and protocol resolution from `X-Forwarded-*` headers (`apps/server/src/index.ts`).
   - Correct the `CORS_ORIGIN` row: the docs table says default `*`; the actual behavior when unset is that the API reflects the request origin (`origin: process.env.CORS_ORIGIN || true` in `apps/server/src/index.ts`). Add the reverse-proxy guidance: behind an HTTPS reverse proxy, logins work as long as the proxy preserves the Host header, forwards `x-forwarded-host`, or `CORS_ORIGIN` is set to the public URL; forward `x-forwarded-proto` so session cookies carry the Secure attribute over HTTPS (`apps/server/src/lib/betterAuthRequest.ts`, `trustedOriginsForRequest` in `apps/server/src/lib/auth.ts`).
   - Release-notes line for proxy edge case: reverse proxies that rewrite the Host header must forward `X-Forwarded-Host` (or set `CORS_ORIGIN` to the public URL) for cookie login to work.
   - The `## Claim Code` section stays accurate: `CLAIM_CODE` still gates first-owner sign-up (`apps/server/src/utils/claimCode.ts`, enforced in the sign-up hook in `apps/server/src/lib/auth.ts`; verified live: fresh-install sign-up succeeds without it when unset and `setup/status` reports `requiresClaimCode`).

2. `app/getting-started/installation/page.mdx` (Generating Secrets section)
   - Keep `JWT_SECRET` and `COOKIE_SECRET` as the two required secrets. Add `BETTER_AUTH_SECRET` as a third, optional, recommended secret generated the same way (`openssl rand -hex 32`).
   - Extend the secret-rotation warning: rotating `JWT_SECRET` also changes the derived `BETTER_AUTH_SECRET` when it is not set explicitly, which invalidates web sessions and paired mobile devices, not just legacy tokens.

3. `app/getting-started/installation/docker-ui/page.mdx` (env table) and `app/getting-started/installation/kubernetes/page.mdx`
   - Add `BETTER_AUTH_SECRET` as an optional variable with the derivation note. For Kubernetes: the Helm chart's secret handles `JWT_SECRET`, `COOKIE_SECRET`, `DB_PASSWORD` only and has no `BETTER_AUTH_SECRET` key (`docker/helm/tracearr/values.yaml`, `templates/secret.yaml`), so chart installs rely on derivation; say so rather than inventing a chart value.

4. `app/getting-started/first-server/page.mdx` (login methods page)
   - `## Initial Setup` and `### Plex (Recommended)` stay accurate: Plex sign-in exists as Better Auth plugin endpoints `/api/v1/auth/plex/initiate`, `check-pin`, `connect` (initiate and check-pin verified live against plex.tv; `connect` UNVERIFIED live because it needs a human authorizing the PIN, covered by route tests).
   - Add OIDC: when `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` are set, the login page shows an SSO button labeled by `OIDC_PROVIDER_NAME` (`apps/server/src/routes/setup.ts`, `apps/web/src/pages/Login.tsx`).
   - `### Jellyfin` and `### Emby` stay accurate (create a local account, then connect the server via API key; `connect-api-key` was kept). Add an upgrade note: signing in to Tracearr with Jellyfin credentials was removed in this release; the old endpoint now returns 404 (verified live).

5. `app/configuration/mobile/page.mdx`
   - Correct the pairing token expiry: the docs say 5 minutes; the actual value is 15 minutes (`TOKEN_EXPIRY_MINUTES = 15` in `apps/server/src/routes/mobile.ts`; verified live, `expiresAt` was 15 minutes after issue). Affects the callout after the QR steps and the "Invalid QR code" troubleshooting entry.
   - Device limit of 5 stays accurate (`MAX_PAIRED_DEVICES = 5`).
   - The `trr_mob_...` token prefix stays accurate (verified live on `/mobile/pair-token`).
   - Add device session expiry, scoped by pairing date: devices paired after this release use a 90-day rolling window extended by use (the 30-day Better Auth session, `session.expiresIn` in `apps/server/src/lib/auth.ts`, is re-minted by the refresh token, `MOBILE_REFRESH_TTL` 90 days in `apps/server/src/routes/mobile.ts`), so 90 idle days means re-pairing. Devices paired before this release stay on the legacy token shim, which refreshes on use with a database fallback and does not expire on idle; they keep working until re-paired.

6. `app/faq/page.mdx` (password reset entry)
   - The recovery scripts now ship compiled in the image (`apps/server/dist/scripts/`); the canonical commands are `docker exec -it tracearr node apps/server/dist/scripts/reset-password.js` and `docker exec tracearr node apps/server/dist/scripts/cli.js <command>` with commands `reset-password [username] [--generate]`, `set-username`, `set-email`, `list-users`, `enable-local-login` (source `apps/server/scripts/cli.ts`; verified under plain node against the compiled output and a live database: `list-users` printed the owner with its login methods, and `reset-password --generate` completed end to end). Update every documented command to the `dist/scripts/*.js` path, including the Proxmox variants (`node /opt/tracearr/apps/server/dist/scripts/reset-password.js`). The old raw invocations (`node apps/server/scripts/reset-password.ts`) still work inside the image via Node's type stripping, so stale copies of the docs do not strand anyone, but the compiled path is the one to publish since it works in every install shape.
   - Correct the claim that reset does not work for external auth (Plex sign-in) users: `reset-password` now creates the credential account row when the user has no password (`resetPasswordCommand` in `apps/server/scripts/lib/commands.ts` inserts a `credential` row when none exists), so it works for any user. It also revokes all of the user's existing sessions.
   - The reverse-proxy FAQ entry about forwarded headers is about media servers and stays as is, but can cross-link the new `TRUST_PROXY`/`CORS_ORIGIN` guidance.

7. New page: recovery/admin CLI, suggested `app/configuration/recovery/page.mdx`
   - Content: lockout scenarios (Jellyfin-login installs after upgrade, disabled local login, lost password), each CLI command with Docker and pnpm invocations (Docker: `docker exec -it tracearr node apps/server/dist/scripts/cli.js <command>`; pnpm: `pnpm --filter @tracearr/server cli <command>`, which now runs the compiled output), note that reset-password works with no existing password and kills existing sessions, and Plex login as the no-CLI recovery path when linked.
   - Wire-up: entry in `app/configuration/_meta.ts` and a manual entry in `app/sitemap.ts`, frontmatter per site convention.

8. Release note (Jellyfin removal): the site has no changelog or release-notes page at all. Either add a release-notes section to `app/upgrading/page.mdx` or create a new page (plus `_meta.ts` and `app/sitemap.ts` entries). Use the release-notes draft above; the three items in that order, Jellyfin removal first.

9. `app/upgrading/page.mdx`: add this release's upgrade callouts regardless of where the full notes land: run migrations before starting the new version, all web users log in once, newly paired devices use a 90-day rolling session (pre-upgrade pairings keep working unchanged), Jellyfin login removed with the recovery paths.

10. `app/getting-started/installation/supervised/page.mdx`: no content change required; confirm the "secrets are generated automatically on first boot" claim still holds (it does: the supervised entrypoint generates and persists `JWT_SECRET`, `docker/entrypoint-supervised.sh`, and `BETTER_AUTH_SECRET` derivation keeps those installs zero-config).

11. `app/configuration/backup/page.mdx`: the post-restore sentence "sessions are invalidated, requiring users to re-login" remains true after the migration (sessions live in the database and Redis; a restore without the matching Redis state invalidates them). No change required beyond confirming wording.

## Post-release follow-ups (later cleanup release, do not ship now)

- Drop `users.password_hash`
- Drop legacy JWT verification and the mobile refresh-hash columns
- Retire `JWT_SECRET`
- Remove the socket and `requireMobile` legacy branches

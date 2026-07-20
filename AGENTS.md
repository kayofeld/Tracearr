# AGENTS.md — orientation for AI coding agents

Concise, high-signal map of this repo for automated agents. Read this before editing. It complements
`README.md` (user-facing) and `docs/project-context.md` (delivery context). This is the **kayofeld fork**
of `connorgallopo/Tracearr`; see the README's fork note for the different direction.

## What this is

Self-hosted real-time monitoring for Plex / Jellyfin / Emby: session tracking, analytics, and
account-sharing detection. A pnpm + Turborepo TypeScript monorepo. A single Node process serves both the
REST/JSON API and the built web UI.

## Repo layout

```
apps/
  server/     Fastify API + all backend logic (the core)
  web/        React 19 SPA (Vite/rolldown), served by the server in prod
  mobile/     Expo / React Native (iOS + Android)
  e2e/        Playwright end-to-end
packages/
  shared/       Cross-cutting TS types + zod schemas (@tracearr/shared)
  translations/ i18n locales (@tracearr/translations), 30 languages
docker/       Dockerfiles, compose examples, Helm chart, systemd units
scripts/      Ops scripts — update.sh is the bare-metal self-updater
docs/         Delivery docs, ADRs, backlog, retro
```

## Key commands

- `pnpm install --frozen-lockfile` — install (Node ≥ 22, pnpm ≥ 11.8 via `corepack enable`).
- `pnpm dev` — web on :5173, API on :3000.
- `pnpm build` — Turbo build all packages (server = `tsc`; web = `tsc && vite build`).
- `pnpm local-ci` — **reproduces the CI gate**: typecheck + lint + tests + build + translation check. Run
  this before declaring work done. (Fork Actions are not enabled, so this + review is the gate.)
- Targeted: `pnpm --filter @tracearr/server exec tsc --noEmit`, `... exec vitest run <path>`,
  `pnpm exec eslint <files>`.
- `pnpm --filter @tracearr/server db:migrate` — apply migrations (also runs automatically on server boot).

## Backend (`apps/server`) architecture

- **Framework:** Fastify. Entry `src/index.ts` wires plugins, routes, and background jobs, then
  `app.listen`. Background loops are started after listen and stopped in `onClose` + the maintenance-mode
  transition (see `startPluginUpdateChecker` / `startTelegramCommandListener` for the pattern).
- **DB:** Drizzle ORM over PostgreSQL with the **TimescaleDB** extension (session history is time-series;
  hypertables + continuous aggregates keep dashboards fast). Schema in `src/db/schema.ts`; migrations in
  `src/db/migrations`. Migrations run on startup — no separate migrate step in prod.
- **Queues/scheduling:** Redis + BullMQ. Recurring work lives in `src/jobs/*` (version check, plugin-update
  check, notifications, kill/inactivity/backup queues, aggregator).
- **Auth:** Better Auth (`src/lib/auth.ts`) with username/admin/bearer plugins, JWT + cookie sessions.
  Custom credential plugins: `src/lib/plexPlugin.ts`, `src/lib/embyPlugin.ts`. Accounts link in
  `auth_accounts (providerId, accountId)` (unique). The `authenticate` decorator resolves a Better Auth
  session first, then falls back to legacy JWT (mobile shim).
- **Media servers:** `src/services/mediaServer/*` — per-type clients (plex/jellyfin/emby). Real-time via
  SSE (`src/services/sseManager.ts` + the external SSE plugin) with a polling fallback, plus the fork's
  opt-in native WebSocket source (`.../shared/jellyfinEmbyWebSocketSource.ts`).
- **Notifications:** agent pattern in `src/services/notifications/agents/*` (BaseAgent →
  `shouldSend`/`send`/`sendTest`). Routing in `src/jobs/notificationQueue.ts`. URL-less agents (Telegram)
  route through the `webhook` channel with a `webhookFormat` discriminator.
- **Settings:** key/value store; `getSettings([...keys])` in `src/services/settings.ts`. Adding a new
  setting key needs no migration.
- **Routes:** `src/routes/*` registered under `${API_BASE_PATH}/...` (e.g. `versionRoutes` at
  `/api/version`). Public API + Swagger from `src/routes/public.openapi.ts` at `/api-docs`.

## Frontend (`apps/web`)

React 19 + React Router, TanStack Query for server state, Radix/shadcn + Tailwind, Highcharts, Leaflet,
i18next. API client in `src/lib/api.ts` (one method per endpoint). Translation keys are generated into a
typed union — add a key to `packages/translations/src/locales/en/*.json` then run the translations check
(`check-translations.ts --fix`) to propagate to all locales.

## Conventions

- **Tests-first-ish, always gated.** Vitest for unit/route/service tests (`__tests__` beside source).
  Extract pure logic and unit-test it; the gate (`pnpm local-ci`) is the safety net. TypeScript is strict
  with `noUncheckedIndexedAccess` — guard `arr[i]` access.
- **Lint/format:** ESLint + Prettier, Husky pre-commit runs prettier on staged files. Keep new files
  warning-clean (`catch (err: unknown)`).
- **Secrets never in logs.** Tokens live in the settings store / env, never in source or log lines. When
  logging fetch errors that could embed a token-bearing URL, redact (see
  `src/jobs/telegramCommandListener.ts`).
- **Line endings:** shell scripts are LF (`.gitattributes` enforces `*.sh eol=lf`) — a CRLF `.sh` won't run
  on Linux.

## Fork subsystems (where the fork diverges) + gotchas

- **Emby auth (`src/services/mediaServer/emby/client.ts`, `src/lib/embyPlugin.ts`):** Emby's
  `/Users/AuthenticateByName` needs the plaintext password in the **`Pw`** field, NOT `Password` (a
  `Password`-field request returns 401 — this was a real bug). The server URL is always the configured
  server, never client-supplied (auth-bypass hardening).
- **In-app self-update (`apps/server/src/routes/version.ts`, `scripts/update.sh`,
  `docker/systemd/tracearr-update.service`):** `POST /api/version/update` (owner-only, requires
  `TRACEARR_SELF_UPDATE=true`, non-Docker) spawns a **fixed argv** `sudo systemctl start --no-block
tracearr-update.service`. `update.sh` re-execs from `/tmp` (so a checkout that changes the script can't
  corrupt the running one), **validates the target tag as strict semver `^v\d+\.\d+\.\d+$`**, builds before
  restarting, and stamps `APP_VERSION`. The sudoers rule must match the invoked argv exactly (including
  `--no-block`). Version scheme is 3-part semver — a 4-part tag would be rejected by the updater.
- **Version checker (`src/jobs/versionCheckQueue.ts`):** defaults to `kayofeld/Tracearr` (the fork),
  overridable via `TRACEARR_UPDATE_REPO`. Drives both the update notice and the self-update target.
- **Telegram (`src/services/notifications/agents/telegram.ts`, `src/jobs/telegramCommandListener.ts`):**
  send via `sendMessage`; the listener long-polls `getUpdates` and answers `/start`/`/chatid` with the chat
  ID. The listener uses a generation counter so start/stop can't leave two loops polling the same token
  (Telegram returns 409 for concurrent pollers).
- **Image proxy (`src/services/imageProxy.ts`):** origin-locked (`resolveSameOrigin`) to prevent
  token-exfiltration / SSRF.

## Deployment reality (the fork)

Bare-metal / systemd, run from source at `/opt/Tracearr` (capital T), owned by a `tracearr` user, Node ≥ 22
at `/usr/local/bin/node`, `EnvironmentFile=/opt/Tracearr/.env` on the unit. The fork does not publish Docker
images. Releases: bump the 3 `package.json` versions, `chore(release): vX.Y.Z` commit, annotated `vX.Y.Z`
tag, GitHub release. See `docs/project-context.md` for the full contribution/release flow.

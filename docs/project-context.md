# Project Context - tracearr

> Loaded at intake; every specialist reads it. Derived from the repo on 2026-07-20.
> Keep it current - it is the single source of truth.

## 0. Repository (which platform & connector)

- **Platform / connector:** GitHub (`mcp__github`)
- **Remote URL:** https://github.com/connorgallopo/Tracearr.git
- **Org / group / project:** connorgallopo/Tracearr (owner: Connor Gallopo)
- **Local path:** projects/tracearr/
- **Default branch:** main
- **Tracker / board:** GitHub Issues + Projects
- **CI:** GitHub Actions (`ci.yml`, `nightly.yml`); Docker images to `ghcr.io/connorgallopo/tracearr`; translations via Crowdin
- **License:** AGPL-3.0 (this is an existing open-source project, not a greenfield build)
- **Contribution model (updated 2026-07-20): FORK-DIRECT. Paul maintains his own fork `kayofeld/Tracearr` as the live line - NO PRs to upstream `connorgallopo/Tracearr`.** Remotes: `origin` = kayofeld fork (push target), `upstream` = connorgallopo (fetch only, NEVER push). Work on feature branches, Fable-review gate, then merge `--no-ff` into fork `main` and push - Paul authorized direct main merges on the fork (2026-07-20). Claude never opens PRs anywhere (standing rule).

## 1. Summary

- **Problem / opportunity:** Tautulli only monitors Plex; Jellystat only Jellyfin/Emby. Anyone running more than one media server juggles multiple dashboards, and none of them detect account/credential sharing.
- **Desired outcome:** One self-hosted platform that monitors Plex, Jellyfin, and Emby together - real-time session tracking, playback/library analytics, and account-sharing detection.
- **Target users / personas:** Self-hosters and homelab operators running one or more Plex/Jellyfin/Emby servers.
- **Success metrics:** Not owner-declared. Proxy signals from the repo: adoption (GitHub stars/releases, Docker pulls), Discord community, Crowdin localization coverage.

## 2. Scope

- **In scope:** Multi-server dashboard; session tracking with geolocation (MaxMind GeoLite2 City/ASN); stream analytics (transcode vs direct, bandwidth, codec/resolution/device); library analytics (overview, quality, storage, watch); Live TV & Music; stream world map; sharing detection (impossible travel, simultaneous locations, device velocity, concurrent streams, geo restrictions, account inactivity); trust scores; real-time alerts (Discord webhooks, push); read-only public REST API + Swagger UI; bulk actions; data import (Tautulli/Jellystat); web app + iOS/Android mobile app.
- **Out of scope:** Media management/downloading (the *arr download stack), transcoding itself - Tracearr observes the media servers, it does not run them.
- **MVP definition:** Product is well past MVP - shipping releases (v0.x) with web + mobile + server + e2e already built. Treat work here as feature/maintenance on a live codebase, not a from-zero build.
- **Engagement type:** software

## 3. Constraints

- **Timeline / milestones:** Not set (OSS project, release-driven not deadline-driven).
- **Budget / cost ceiling:** N/A (self-hosted OSS; funded via Ko-Fi).
- **Compliance / data residency:** Self-hosted by the operator; no central data collection by the project. Handles personal data (usernames, IP addresses, geolocation) so privacy matters - see `docs/PRIVACY_POLICY.md`.
- **Stakeholders & sign-off:** Repo owner Connor Gallopo. Paul (this team) works as a contributor via feature branches + PRs.

## 4. Technical context (OVERRIDES the team defaults - this is not a Python/Azure project)

- **Monorepo:** pnpm (>=11.8) + Turborepo; Node >=22.22; TypeScript 6; strict lint/format via ESLint + Prettier; Husky pre-commit/-push + lint-staged.
- **Apps:**
  - `apps/server` - **Fastify** API. Drizzle ORM over **Postgres/TimescaleDB**, **Redis** (ioredis) + **BullMQ** jobs, **better-auth** (JWT/cookies), **socket.io** + SSE for real-time, MaxMind (`maxmind`) geolocation, Expo push (`expo-server-sdk`), Swagger/OpenAPI docs.
  - `apps/web` - **React 19** + **React Router**, TanStack Query/Table/Virtual, Radix UI + shadcn + Tailwind, Highcharts, Leaflet (stream map), i18next, socket.io-client.
  - `apps/mobile` - **Expo / React Native** (expo-router, Reanimated, Skia, victory-native, zustand, EAS build).
  - `apps/e2e` - end-to-end tests.
  - Shared packages: `@tracearr/shared`, `@tracearr/translations`.
- **Datastore:** PostgreSQL + TimescaleDB (time-series session data); Redis for cache/queues.
- **Deploy:** Docker (`docker/` compose + Dockerfiles, incl. supervised + timescale variants) and a **Helm** chart (`docker/helm`). Self-hosted; **not Azure/Bicep**.
- **Tests:** Vitest (unit/services/routes/security/integration), Playwright-style e2e; `pnpm local-ci` reproduces the CI gate locally against `docker-compose.test.yml`. **Not pytest.**
- **Key integrations / external systems:** Plex, Jellyfin, Emby (media servers); Discord webhooks; MaxMind GeoLite2; Tautulli/Jellystat import; Crowdin (i18n).

## 5. Non-functional requirements

- **Performance:** Real-time session ingestion via pollers + SSE/websockets; recent commits harden SSE reconciliation and concurrent stop/kill handling. Time-series analytics rely on TimescaleDB.
- **Availability / SLA:** Self-hosted, operator-owned; no project SLA. RPO/RTO governed by the operator's Postgres backups.
- **Security / privacy:** Handles personal data (users, IPs, geolocation, playback history). Recent work closed cross-user sessionKey guard holes and hardened auth (better-auth migration - see `docs/auth-migration-rollout.md`). Dedicated `test:security` suite. AGPL-3.0.
- **Scalability / load:** Scales to a household/small-community's servers and streams; TimescaleDB + Redis + BullMQ absorb ingestion and background work.

## 6. Decisions & open questions

- **Decisions made:** Fastify + Drizzle + Postgres/TimescaleDB + Redis/BullMQ backend; React 19 + Expo clients; better-auth for auth (migration in progress/rollout, see `docs/auth-migration-rollout.md`); pnpm+turbo monorepo; Docker + Helm delivery.
- **Decided 2026-07-20:** Contribution is **fork-and-PR** (no write access to upstream). See section 0.
- **Open questions (resolve at first-task time):**
  1. What is the actual task on tracearr - a specific feature, bug, or review? (Not yet stated; context-ingestion only so far.)
  2. Which fork / GitHub account hosts Paul's copy, so the fork remote can be wired up?

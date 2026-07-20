<p align="center">
  <img src="apps/web/public/images/og_image.png" alt="Tracearr" width="600" />
</p>

<p align="center">
  <strong>Real-time monitoring for Plex, Jellyfin, and Emby. One dashboard for all your servers.</strong>
</p>

<p align="center">
  <a href="https://github.com/kayofeld/Tracearr/releases"><img src="https://img.shields.io/github/v/release/kayofeld/Tracearr?style=flat-square&color=18D1E7&label=fork%20release" alt="Latest Fork Release" /></a>
  <a href="https://github.com/kayofeld/Tracearr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/kayofeld/Tracearr?style=flat-square" alt="License" /></a>
  <a href="https://github.com/connorgallopo/Tracearr"><img src="https://img.shields.io/badge/fork%20of-connorgallopo%2FTracearr-6e7681?style=flat-square&logo=github" alt="Fork of upstream" /></a>
  <a href="https://discord.gg/a7n3sFd2Yw"><img src="https://img.shields.io/discord/1444393247978946684?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
  <a href="https://docs.tracearr.com"><img src="https://img.shields.io/badge/docs-tracearr.com-18D1E7?style=flat-square" alt="Documentation" /></a>
</p>

> [!NOTE]
> **This is a fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr)** maintained by
> [@kayofeld](https://github.com/kayofeld), with a different direction. All credit for Tracearr goes to
> the upstream author; this fork builds on that work under AGPL-3.0.
>
> **What's different here:**
>
> - **Bare-metal / source first.** Upstream is Docker-first; this fork is built and run from source and
>   ships an **in-app one-click self-update** for systemd hosts (no `docker pull` loop). See
>   [Updating](#updating).
> - **Emby-first.** Sign in with **Emby credentials** (not only Plex), hardened Emby admin verification,
>   and an opt-in **native Emby/Jellyfin WebSocket** real-time tier.
> - **Telegram notifications** plus a bot that answers `/start` with your chat ID so setup is painless.
> - **User delete / resync** from the users view, and a **security-hardened image proxy** (origin-locked
>   against token exfiltration).
>
> The fork tracks upstream via the `upstream` remote but ships independently: releases, the in-app update
> checker, and the self-update button all follow **kayofeld/Tracearr** (configurable via
> `TRACEARR_UPDATE_REPO`). The fork does **not** publish its own Docker images — run it from source.

---

Tracearr is a monitoring platform for **Plex**, **Jellyfin**, and **Emby**. Track streams in real-time, dig into playback analytics, and spot account sharing before it gets out of hand.

## What It Does

**Multi-Server Dashboard** — Connect Plex, Jellyfin, and Emby to a single interface. No more switching between apps.

**Session Tracking** — Complete session history: who watched what, when, where, and on what device. Every stream includes geolocation data.

**Stream Analytics** — See what's transcoding vs direct playing, track bandwidth usage, and see what people actually watch. Codec breakdowns, resolution stats, device compatibility scores. Enhanced IP geolocation includes ASN data, continent, and postal codes.

**Library Analytics** — Four dedicated pages to understand your media collection:

- **Overview** — Item counts, storage usage, growth charts over time.
- **Quality** — Resolution and codec distribution. Track how your 4K vs 1080p ratio changes.
- **Storage** — Usage predictions, duplicate detection across servers, stale content identification, and ROI analysis (watch hours per GB).
- **Watch** — Engagement metrics, completion rates, viewing patterns by hour and month, binge detection.

**Live TV & Music** — Not just movies and shows. Track live TV sessions and music playback across all your servers.

**Stream Map** — Visualize where your streams originate on a world map. Filter by user, server, or time period.

**Sharing Detection** — Six rule types flag suspicious activity:

- **Impossible Travel** — NYC then London 30 minutes later? That's not one person.
- **Simultaneous Locations** — Same account streaming from two cities at once.
- **Device Velocity** — Too many unique IPs in a short window signals shared credentials.
- **Concurrent Streams** — Set limits per user.
- **Geo Restrictions** — Block streaming from specific countries.
- **Account Inactivity** — Get notified when accounts go dormant for a configurable period.

**Trust Scores** — Users earn (or lose) trust based on behavior. Violations drop scores automatically.

**Real-Time Alerts** — Discord, Telegram, and custom webhook notifications fire instantly when rules trigger.

**Public API** — Read-only REST API for third-party integrations. Generate an API key in Settings, then explore endpoints at `/api-docs` (Swagger UI). Works with Homarr, Home Assistant, or anything that speaks HTTP.

**Bulk Actions** — Multi-select operations across tables. Acknowledge or dismiss violations in bulk, reset trust scores, enable/disable rules, delete session history.

**Data Import** — Already using Tautulli or Jellystat? Import your watch history so you don't start from scratch.

## Fork Additions

Features this fork ships on top of upstream (all security-reviewed and live-tested):

- **Emby credential login** — sign in with your Emby username/password, not just Plex. Owner-only,
  trust-on-first-use, server URL is never taken from the client (auth-bypass hardened).
- **In-app self-update** — an **Update** button for bare-metal/systemd deploys. A separate systemd unit
  runs the update in its own cgroup (survives the app restart), validates the release tag, builds
  **before** restarting, then restarts. Opt-in via `TRACEARR_SELF_UPDATE=true`. See [Updating](#updating).
- **Telegram** — a full notification channel, plus a bot that replies to `/start` and `/chatid` with the
  sender's chat ID so you can configure notifications without hunting for the ID.
- **Native Emby/Jellyfin WebSocket** — an opt-in real-time tier (`TRACEARR_NATIVE_WS_ENABLED=true`) that
  connects to the media server's own WebSocket instead of relying solely on the SSE plugin.
- **User delete / resync** — remove or re-sync users directly from the users view (deleted media-server
  users no longer linger).
- **Hardened image proxy** — the poster/artwork proxy is origin-locked, closing a token-exfiltration / SSRF
  vector present upstream.

## Why Tracearr?

Tautulli only works with Plex. Jellystat only works with Jellyfin and Emby. If you run multiple servers, you're stuck with multiple dashboards.

Tracearr handles all three. One install, one interface.

|                           | Tautulli | Jellystat | Tracearr |
| ------------------------- | -------- | --------- | -------- |
| Watch history             | ✅       | ✅        | ✅       |
| Statistics & graphs       | ✅       | ✅        | ✅       |
| Session monitoring        | ✅       | ✅        | ✅       |
| Transcode analytics       | ✅       | ✅        | ✅       |
| Live TV & Music           | ✅       | ✅        | ✅       |
| Account sharing detection | ❌       | ❌        | ✅       |
| Impossible travel alerts  | ❌       | ❌        | ✅       |
| Trust scoring             | ❌       | ❌        | ✅       |
| Plex support              | ✅       | ❌        | ✅       |
| Jellyfin support          | ❌       | ✅        | ✅       |
| Emby support              | ❌       | ✅        | ✅       |
| Multi-server dashboard    | ❌       | ❌        | ✅       |
| IP geolocation            | ✅       | ✅        | ✅       |
| Library analytics         | ✅       | ✅        | ✅       |
| Public API                | ✅       | ✅        | ✅       |
| Import from Tautulli      | —        | ❌        | ✅       |
| Import from Jellystat     | ❌       | —         | ✅       |

## Quick Start

> [!IMPORTANT]
> This fork is **run from source** — it does not publish its own Docker images. The `ghcr.io/connorgallopo/*`
> images below are **upstream's** and do **not** include this fork's features. To run the fork, use the
> [Manual install](#manual-install-source-build) below (or build your own image from this repo). The Docker
> instructions are kept as a reference for upstream users.

### Manual install (source build)

This is the fork's primary install path. Tracearr runs as a single Node process that serves both the API and the web UI. You bring your own PostgreSQL and Redis.

**Prerequisites**

- Node.js 22+ and pnpm 11.8+ (`corepack enable` provides pnpm)
- PostgreSQL 16+ with the TimescaleDB extension enabled on the database
- Redis 7+

**Install and build**

```bash
git clone https://github.com/kayofeld/Tracearr.git
cd Tracearr
pnpm install --frozen-lockfile
pnpm build
```

**Configure** — create `.env` in the repository root (the server loads it automatically):

```bash
cat > .env <<EOF
DATABASE_URL=postgres://tracearr:tracearr@localhost:5432/tracearr
REDIS_URL=redis://localhost:6379
JWT_SECRET=$(openssl rand -hex 32)
COOKIE_SECRET=$(openssl rand -hex 32)
NODE_ENV=production
PORT=3000
HOST=0.0.0.0
APP_VERSION=$(git describe --tags --always 2>/dev/null | sed 's/^v//')
EOF
```

`APP_VERSION` is what the in-app update checker compares against the latest release, so set it to the deployed tag (the update script re-derives it from `git describe` on each pull). See `.env.example` for the full list of optional settings (`CORS_ORIGIN` and `TRUST_PROXY` behind a reverse proxy, OIDC sign-in, the opt-in native-WebSocket real-time tier, `TRACEARR_UPDATE_REPO`, `TRACEARR_SELF_UPDATE`, and more).

**Run.** The process reads its configuration from the environment, so export `.env` into the shell before starting it directly:

```bash
set -a; source .env; set +a
node apps/server/dist/index.js
```

The server applies database migrations on startup, then serves the app at `http://localhost:3000` (or your `PORT`). There is no separate migrate step. Bundled GeoLite2 databases under `data/` give geolocation out of the box.

**Keep it running** with a process manager. Example systemd unit at `/etc/systemd/system/tracearr.service` (assuming the repo is checked out at `/opt/Tracearr`):

```ini
[Unit]
Description=Tracearr
After=network.target postgresql.service redis-server.service

[Service]
WorkingDirectory=/opt/Tracearr
# systemd injects the .env values into the process environment. This is required:
# the app reads DATABASE_URL/REDIS_URL at startup, so they must be real env vars.
EnvironmentFile=/opt/Tracearr/.env
# Use your Node >= 22 binary. `/usr/bin/node` is often an older distro Node that
# fails at startup (ERR_REQUIRE_ESM); check with `which node` / `node -v` and use
# that absolute path (commonly /usr/local/bin/node).
ExecStart=/usr/local/bin/node apps/server/dist/index.js
Restart=on-failure
User=tracearr

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now tracearr` (with the repo at `/opt/Tracearr`, `.env` in that directory, and the `tracearr` user owning it: `sudo chown -R tracearr:tracearr /opt/Tracearr`).

### Docker (upstream images)

If you'd rather run **upstream** Tracearr (without this fork's features), the upstream images are the fastest path:

```bash
# Download compose file
curl -O https://raw.githubusercontent.com/connorgallopo/Tracearr/main/docker/examples/docker-compose.pg18.yml

# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# Deploy
docker compose -f docker-compose.pg18.yml up -d
```

Open `http://localhost:3000` and connect your Plex, Jellyfin, or Emby server. See upstream's [Docker deployment guide](docker/examples/README.md) and [docs.tracearr.com](https://docs.tracearr.com). To run **this fork** in Docker, build the image yourself from this repo (`docker build -f docker/Dockerfile -t tracearr:fork .`).

## Updating

This fork's headline convenience: **update from the interface** on bare-metal/systemd deploys.

- **In-app Update button.** When a newer release is available and self-update is enabled, an **Update**
  button appears in the app. It triggers a separate systemd unit (`tracearr-update.service`) that pulls the
  latest release tag, reinstalls, builds, then restarts — with live progress in the UI. The build runs
  **before** the restart, so a failed build leaves the current version running.

  One-time host setup:
  1. Install the unit: `sudo cp docker/systemd/tracearr-update.service /etc/systemd/system/ && sudo systemctl daemon-reload`
  2. Add the scoped sudoers rule (see the unit file's header for the exact line — it must match the invoked argv, including `--no-block`).
  3. Set `TRACEARR_SELF_UPDATE=true` in `.env` and restart.

- **Manual update** (always available):

  ```bash
  git pull
  pnpm install --frozen-lockfile
  pnpm build
  sudo systemctl restart tracearr
  ```

  Or run `scripts/update.sh`, which does the fetch → checkout latest tag → install → build → restart for you (this is what the Update button runs).

Migrations run automatically on the next start.

### Docker Tags (upstream)

Reference for upstream's published images (this fork does not publish images):

| Tag                  | Description                                        |
| -------------------- | -------------------------------------------------- |
| `latest`             | Stable release (requires external DB/Redis)        |
| `supervised`         | All-in-one stable release                          |
| `next`               | Latest prerelease (requires external DB/Redis)     |
| `supervised-next`    | All-in-one prerelease                              |
| `nightly`            | Bleeding edge nightly (requires external DB/Redis) |
| `supervised-nightly` | All-in-one nightly build                           |

```bash
docker pull ghcr.io/connorgallopo/tracearr:supervised   # all-in-one (upstream)
docker pull ghcr.io/connorgallopo/tracearr:latest        # stable (upstream)
```

### Viewing Logs

**Bare-metal / systemd:**

```bash
journalctl -u tracearr        # Application logs
journalctl -u postgresql      # Database logs
journalctl -u redis           # Cache logs
```

**Docker** — each service runs in its own container:

```bash
docker logs tracearr          # Application logs
docker logs tracearr-postgres # Database logs
docker logs tracearr-redis    # Cache logs
```

Set `LOG_LEVEL=debug` for verbose output.

### Development Setup

```bash
# Install dependencies (requires pnpm 11.8+, Node.js 22+)
pnpm install

# Start database services
docker compose -f docker/docker-compose.dev.yml up -d

# Copy and configure environment
cp .env.example .env

# Run migrations
pnpm --filter @tracearr/server db:migrate

# Start dev servers
pnpm dev
```

Frontend runs at `localhost:5173`, API at `localhost:3000`. `pnpm local-ci` reproduces the CI gate (typecheck, lint, tests, build, translation check) locally — the fork relies on this plus review, since fork Actions are not enabled.

## Stack

| Layer     | Tech                                      |
| --------- | ----------------------------------------- |
| Frontend  | React 19, TypeScript, Tailwind, shadcn/ui |
| Charts    | Highcharts                                |
| Maps      | Leaflet                                   |
| Backend   | Node.js, Fastify                          |
| Database  | TimescaleDB (PostgreSQL extension)        |
| Cache     | Redis                                     |
| Real-time | Socket.io + SSE (+ opt-in native WS)      |
| Auth      | Better Auth (Plex + Emby credential)      |
| Monorepo  | pnpm + Turborepo                          |

**TimescaleDB** handles session history. Regular Postgres works for a few months, but long query histories kill performance. TimescaleDB is built for time-series data—dashboard stats stay fast because they're pre-computed, not recalculated every page load.

**Fastify** over Express because it's measurably faster and schema validation catches bad requests before they hit handlers.

**SSE for instant sessions** — Plex streams session updates in real-time via Server-Sent Events, so streams appear the moment they start. Jellyfin and Emby get the same through the [Tracearr SSE plugin](https://github.com/Tracearr/Media-Server-SSE); without it they fall back to polling (or the opt-in native WebSocket tier in this fork).

## Project Structure

```
tracearr/
├── apps/
│   ├── web/          # React frontend
│   ├── server/       # Fastify backend
│   └── mobile/       # React Native app (iOS & Android)
├── packages/
│   ├── shared/       # Types, schemas, constants
│   └── translations/ # i18n support
├── docker/           # Compose files, Dockerfiles, systemd units, Helm chart
├── scripts/          # Ops scripts (update.sh — the self-updater)
└── docs/             # Documentation
```

See [`AGENTS.md`](AGENTS.md) for an architecture map written for AI coding agents (module layout, conventions, subsystems, and gotchas), and [`CHANGELOG.md`](CHANGELOG.md) for this fork's release history.

## Community

Upstream community (shared with this fork):

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/a7n3sFd2Yw)

For issues specific to **this fork**, [open an issue on kayofeld/Tracearr](https://github.com/kayofeld/Tracearr/issues). For upstream Tracearr, use the [upstream repo](https://github.com/connorgallopo/Tracearr/issues).

## Contributing

This is a personal fork run **fork-direct** (work lands on `main` after local gates + review). If you want to
contribute to Tracearr broadly, consider [upstream](https://github.com/connorgallopo/Tracearr) — it takes
PRs. For a fork-specific fix:

1. Fork this repo and branch from `main`
2. Make your changes; run `pnpm test && pnpm lint` (or `pnpm local-ci`)
3. Open a PR against `kayofeld/Tracearr`

### Development with VS Code

Use the included `.vscode/launch.json` to debug both server and web apps directly from VS Code. Run `pnpm dev`, then use the "Debug All" configuration to attach the debugger.

## Roadmap

**Shipped (upstream + fork)**

- [x] Multi-server Plex, Jellyfin, and Emby support
- [x] Session tracking with full history
- [x] Sharing detection rules
- [x] Real-time WebSocket updates
- [x] SSE for instant session detection (Plex built-in, Jellyfin/Emby via plugin)
- [x] Discord + webhook notifications
- [x] **Telegram notifications** (fork) + `/start` chat-ID helper
- [x] Interactive stream map
- [x] Trust scores
- [x] Tautulli & Jellystat history import
- [x] Transcode analytics & device compatibility
- [x] Live TV & music tracking
- [x] Stream quality metrics (codec, resolution, bitrate)
- [x] Rule-based automated stream termination
- [x] Library analytics (storage, quality, duplicates, engagement)
- [x] Public REST API with Swagger UI
- [x] Account inactivity detection
- [x] Bulk actions for violations, users, rules, sessions
- [x] Enhanced IP geolocation (ASN, continent, postal code)
- [x] Mobile app — [iOS](https://apps.apple.com/us/app/tracearr/id6755941553) and [Android](https://play.google.com/store/apps/details?id=com.tracearr.mobile)

**Fork direction**

- [x] Emby credential login
- [x] In-app self-update (bare-metal / systemd)
- [x] Native Emby/Jellyfin WebSocket real-time tier (opt-in)
- [x] User delete / resync from the view
- [x] Hardened image proxy (origin-lock)
- [ ] Beta-features validation (backup/import/mobile-beta/beta-channel)
- [ ] Periodic auto user-sync
- [ ] Additional notification channels

## License

[AGPL-3.0](LICENSE) — Open source with copyleft protection. If you modify Tracearr and offer it as a service, you share your changes.

This fork is © its contributors and builds on **[connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr)** © the original authors, distributed under the same AGPL-3.0 license.

---

<p align="center">
  <sub>For Plex, Jellyfin, and Emby admins who want to see what's actually happening.</sub>
</p>

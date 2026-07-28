# Changelog — kayofeld/Tracearr fork

Release history for this fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr).
The fork tracks upstream but ships independently; entries below are the fork's own line. Versions are
3-part semver (the in-app self-updater validates tags as `vX.Y.Z`).

## v1.9.0 — Seerr connector, and email-free sign-up

- **Seerr connector** (seerr-team/seerr), a sibling to Ombi: point it at your instance and request
  history is mirrored so library items can be attributed to whoever asked for them. Seerr sends a
  media-server user id with every request, so requesters resolve automatically - on the reference
  instance all 108 requests attributed with no manual mapping needed.
- Both connectors now share one table with a `source` column, so the statistics, the "Requested By"
  column and the requester page span them: one person requesting from both is one row, an item
  requested in both counts once, and anything unmatched stays in an explicit unattributed bucket.
  Existing Ombi data migrates in place.
- **Sign-up no longer requires an email address.** Better Auth's own sign-up endpoint mandates one,
  so this adds a username sign-up path built on its internals - no placeholder addresses are stored,
  and supplying an email is still supported.
- Hardening from review: sign-up is now atomic, so a database blip mid-registration can no longer
  leave an account with no password and lock you out; rate limiting can no longer be disabled by an
  environment variable; a compromised request server can no longer drive the sync out of memory; and
  Seerr status 4 now correctly reads as failed rather than approved.

## v1.8.1 — Docker images for the fork

- The fork now **publishes its own container images** to `ghcr.io/kayofeld/tracearr` (linux/amd64 +
  linux/arm64), built from every release tag: `latest`, the exact version, and `supervised` for the
  all-in-one variant. Previously the only supported path was building from source, and the compose
  examples pointed at upstream's images, which do not contain this fork's features.
- README gains a **Docker / Portainer** section with the tag table, a Portainer stack note (Portainer
  does not read a local `.env`, so the secrets go in the stack editor), and how to update a container
  deployment.
- Compose examples, the Helm chart default, and the Renovate rule now reference the fork's image.

## v1.8.0 — Ombi connector: who requested what

- New **optional Ombi connector**. Point it at your Ombi instance and Tracearr mirrors the request
  history, so library items can be attributed to whoever asked for them. Off until you configure it;
  installs that don't use Ombi see no change anywhere.
- **Requested By** on the Never Watched page, a **per-requester statistics** page (requests made, how
  many were never watched, and the storage those unwatched requests occupy), and the same
  requested-but-never-watched figure on each **user profile**.
- Requesters are matched to Tracearr users by username, with a **mapping screen** for the ones that
  don't match or are ambiguous. Anything unmatched stays in an explicit **unattributed** bucket rather
  than being silently dropped, so the totals stay honest about media that never came through Ombi.
- Settings panel with test-connection, manual sync and live progress; a **purge** control appears once
  you disconnect, so mirrored data can be removed deliberately rather than by surprise.
- Syncs every 6 hours, and once immediately when you first configure it.

## v1.7.0 — Never Watched dashboard page

- New **Library → Never Watched** page: every movie and series that has never been played, with the
  date it was added to the server and how long it has been sitting there. Sortable (oldest first by
  default), paginated, filterable (All / Movies / Series), multi-server aware.
- Statistics on top: never-watched count, total size, share of the library, oldest item, an age
  distribution over five "on server since" buckets, and a per-library breakdown. Backed by a new
  aggregate endpoint `GET /library/never-watched` (auth-gated, server-scoped, cached 1h); the item
  list reuses the existing `/library/stale?category=never_watched`.
- The stale endpoint gained an optional repeated `mediaTypes` filter (backward compatible) so the
  page's table and its stats agree even when music libraries are synced.
- Quality: independent code review (7 findings fixed, two of them High) and a QA pass; first unit
  tests for the `routes/library` family (14 route tests + 9 QA interaction tests); translations
  propagated to all 32 locales.

## v1.6.5 — Documentation & fork identity

- README rewritten as a fork: states the different direction (bare-metal/source-first, Emby-first,
  in-app self-update, Telegram), credits upstream, and leads with the source-build install path.
- Added `AGENTS.md` (architecture map for AI coding agents) and this `CHANGELOG.md`.
- Tracking now points at the fork: the version checker defaults to `kayofeld/Tracearr`
  (`TRACEARR_UPDATE_REPO` still overrides), the in-app GitHub link, OpenAPI contact, and `CODEOWNERS`
  updated. No functional app changes beyond these constants.

## v1.6.4 — Telegram /start chat-ID responder

- The Telegram bot answers `/start` and `/chatid` with the sender's chat ID (long-polling; no webhook
  needed), so configuring the Telegram channel no longer requires hunting for the ID. Activates when a bot
  token is saved in settings; single-loop, resilient to DB blips, drains backlog on start, per-chat
  rate-limited. Security-reviewed and live-tested.

## v1.6.3 — In-app self-update button

- Owner-only, opt-in (`TRACEARR_SELF_UPDATE=true`) **Update** button for bare-metal/systemd deploys. A
  separate `tracearr-update.service` runs the update in its own cgroup (survives the app restart),
  validates the release tag, builds **before** restarting, then restarts. Docker deploys keep the manual
  pull command. `scripts/update.sh` re-execs from `/tmp` for safety. Security-reviewed (tag-injection and
  sudoers argv issues fixed) and live-tested on real hardware.

## v1.6.2 — Telegram notifications + deploy fixes

- Telegram notification channel (alongside Discord/webhook/ntfy). Fixed rule→channel routing for URL-less
  agents. Bare-metal deploy docs corrected (systemd `EnvironmentFile`, Node path pin).

## v1.6.1 — Emby login fix

- Fixed Emby credential authentication: the password must be sent in Emby's `Pw` field (not `Password`),
  which was causing valid credentials to be rejected with 401. (v1.6.0 was withdrawn for this bug.)

## v1.6.0 — Fork foundation (withdrawn, superseded by v1.6.1)

Earlier fork work, consolidated into the 1.6.x line:

- **Emby credential login** — sign in with Emby username/password (owner-only, TOFU, server URL never
  client-supplied). Hardened Emby admin verification.
- **Native Emby/Jellyfin WebSocket** real-time tier (opt-in `TRACEARR_NATIVE_WS_ENABLED`).
- **User delete / resync** from the users view.
- **Hardened image proxy** — origin-locked against token-exfiltration / SSRF.
- **Fork version tracking** — update checker follows the fork (`TRACEARR_UPDATE_REPO`).
- Bundle size reduction (route split), plus assorted review-driven hardening.

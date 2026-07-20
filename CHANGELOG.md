# Changelog — kayofeld/Tracearr fork

Release history for this fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr).
The fork tracks upstream but ships independently; entries below are the fork's own line. Versions are
3-part semver (the in-app self-updater validates tags as `vX.Y.Z`).

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

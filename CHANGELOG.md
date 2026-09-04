# Changelog — kayofeld/Tracearr fork

Release history for this fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr).
The fork tracks upstream but ships independently; entries below are the fork's own line. Versions are
3-part semver (the in-app self-updater validates tags as `vX.Y.Z`).

## v2.3.4: the v2 upgrade migrates an existing fork database on its own

v2.3.0 shipped with a note saying an existing database had to be reconciled by hand before starting it.
That was not a reasonable thing to ask. Installs update themselves, nobody had a script to run, and the
result was a server that came up in maintenance mode and stayed there, logging:

    column "video_dynamic_range" does not exist

Nothing was damaged when that happened. The whole migration batch runs in one transaction, so a database
in this state is exactly where it was before the upgrade, and it will migrate correctly once it is on
this release.

The cause is how the migrator decides what to run. It reads the single highest timestamp in its ledger
and applies everything newer, so it never notices a gap below that mark. The fork's own migrations 0067
to 0071 were written after it branched, which put their timestamps above ten upstream migrations the
fork only inherited at the merge. The migrator skipped all ten and started partway up the chain, where
the first migration that needed one of them failed.

This release repairs that before the migrator runs: it reshapes what the fork's own migrations left
behind so upstream's versions recognise their own tables, then drops the five ledger rows that were
hiding the gap. The upgrade then proceeds normally and your data comes with it. Nothing to run, nothing
to configure. A fresh install and an already-reconciled one both skip it.

If you upgraded to v2.3.0 or later and your server has been sitting in maintenance mode, update to this
release and start it again.

## v2.3.3: Telegram carry-over reads the chat id correctly

- v2.3.2's Telegram carry-over skipped the channel on any real install: the chat id is all digits, and
  the database layer hands an all-digit setting back as a number, which the migration then ignored.
  Caught in rehearsal against a copy of production before it shipped anywhere. Fixed and tested.

## v2.3.2: Telegram survives the upgrade

- The upgrade to the v2 line moves notification channels into Destinations. Upstream's migration
  carries Discord, webhooks and Pushover across; this release carries the fork's Telegram channel too.
  On first start it becomes a Telegram destination with the bot token and chat id stored encrypted,
  enabled when Telegram was the selected format, subscribed to the same events the old routing table
  sent it, and referenced by any rule that used to notify the webhook channel. No re-pairing needed.
- The Snyk workflow is removed from the fork.

The v2.3.0 upgrade note about database reconciliation still applies.

## v2.3.1: green pipelines for the v2 line

No user-facing change. v2.3.0 shipped with red integration, E2E and Snyk jobs, all fallout from the
upstream merge and all confined to tests and workflow wiring:

- Upstream's integration tests create several owner accounts per database; this fork allows exactly one
  owner per instance and keeps that guard, so the extra accounts in those tests are now admins or members.
- Upstream's E2E harness seeded servers and users before the owner signed up, which this fork refuses on
  purpose (an instance with data but no owner must not be claimable from the login page). The seed now
  runs after the owner exists.
- The Snyk scan is skipped when the fork has no Snyk token instead of reporting a broken scan.
- Two fork tests caught up with upstream's renamed `libraries.media_type` column and its per-file size
  model; the never-watched totals in the app were never affected.

The upgrade notes for v2.3.0 (database reconciliation, Telegram re-setup) apply unchanged.

## v2.3.0: caught up with upstream v2.2.3

The fork had been running on its own line since July and was 389 commits behind. This release merges
upstream v2.2.3 in whole. Everything the fork adds is still here; where upstream had independently
built its own version of something the fork already had, upstream's won and the fork's code moved onto
it.

### Read this before upgrading an existing install

Your database will not migrate itself onto this release. The fork numbered its own migrations 0067 to
0071, and upstream had since used those same numbers for different work. This release adopts upstream's
migration chain whole and renumbers the fork's tables to 0097, which leaves a database that already ran
the old numbering in a state the migrator cannot reconcile on its own: it decides what to apply by
timestamp, so it would skip ten upstream migrations whose timestamps predate what the fork already
applied, including the ones that create the tables the new code reads. A fresh install is unaffected.
Reconcile an existing database before starting this version. **As of v2.3.4 this happens automatically
on first start, so upgrade straight to v2.3.4 or later and ignore this paragraph.**

Telegram notifications need setting up again. Upstream replaced the notification-channel model with
destinations, so Telegram is now a destination rather than a channel, and its bot token lives in the
destination's encrypted config instead of a plaintext settings column. That is a better place for it,
but nothing migrates the old value across.

### What upstream brings

- Automations: a rule builder with templates, run history and violation tracking.
- Media browsing: overview, grid, genres and per-title detail pages, with a catalog and shelves behind
  them.
- A map of where streams are coming from, with the basemap bundled rather than fetched.
- A second public API version, with its own rate limiting and documentation.
- Bandwidth statistics, storage and dead-weight views, sort titles, episode-to-show linking, and a
  leader lease so background producers run on one instance instead of all of them.

### What the fork keeps

Ombi and Seerr request attribution, the Never Watched page, the requester statistics page, Emby-native
login, Telegram notifications, the in-app updater, and the played-state mirror are all unchanged in
behaviour. The Never Watched page's played-state logic was rebuilt on top of upstream's rewritten
query, and the pages that list things now use upstream's table component.

### Notes

- Upstream's own take on never-watched content ships alongside the fork's page as the storage and
  dead-weight views. They answer slightly different questions and both are available.
- The image proxy keeps the fork's guard against a media server redirecting the proxy off-origin with
  the access token attached. Upstream had dropped it.
- Web asset paths are now normalised to forward slashes, which lets the repository's own test suite run
  on Windows.

## v1.13.0 — Never Watched now knows what you watched before Tracearr existed

- **The Never Watched page was wrong for a large part of your library, and now isn't.** It worked out
  what you had never watched purely from Tracearr's own session history, which only starts the day you
  installed it. Anything watched before that looked untouched. On the library this was found in, 472 of
  the 1,160 titles it was flagging had in fact been watched — 41% of the page.
- Emby and Jellyfin keep a per-user "played" mark that survives indefinitely, so Tracearr now mirrors
  those marks and treats a title as watched if either its own history or any user's played mark says so.
  Watching one episode counts for the whole show. The mirror refreshes every twelve hours, and there is
  a Sync now button under Settings if you would rather not wait.
- **Where it genuinely doesn't know, it now says so.** Plex has no equivalent per-user mark that Tracearr
  can read, and a server that has not been mirrored yet has nothing to go on. In both cases the page says
  "No recorded plays" rather than claiming the title was never watched, and names the servers it cannot
  vouch for. Saying nothing was watched is a different statement from having no record of it.
- Titles that were played but carry no usable date drop out of the stale list too, rather than appearing
  with an invented age. Emby keeps the fact of an old play but not when it happened.

### Notes

- The mirror is per media-server account, so plays made on an account you have since removed still count
  while that account exists in Tracearr, and vanish with it.
- A refresh that cannot resolve any of your media-server users now reports as failed instead of quietly
  claiming success over an empty mirror, which would have looked identical to "nothing was ever watched".
- Reading the Emby playback-reporting plugin as a second source is designed but not built yet. It carries
  timestamps the played marks lack, so it would restore real dates rather than only removing wrong entries.

## v1.12.1 — fix the first-run end-to-end test

- No user-facing change. The end-to-end suite's setup helper still expected the old single-form
  first-run screen, so it broke when v1.12.0 gave that screen two tabs. It now selects the local
  account tab, and decides "is this a fresh instance" from whether that tab exists rather than racing
  a two-second probe against the tab switch, which made the step intermittently take the sign-in path
  and hang.

## v1.12.0 — set Tracearr up with your Emby account

- **First-run setup can now use Emby directly.** On a fresh instance you give it your Emby server
  address, an admin API key and your Emby username and password, and the owner account is created from
  that — no separate Tracearr password to invent and forget. The setup screen says plainly that Emby
  then becomes your only way in, because recovery from an Emby outage is a console command rather than
  a page in the app.
- Accepting a server address from the browser is exactly what the sign-in path refuses to do, for good
  reason: point it at an Emby you control and you are trivially an administrator there. So it is
  accepted at one endpoint only, and only while the instance is genuinely unclaimed — meaning it holds
  no users, accounts or servers at all. An instance that lost its owner but kept its data is a
  different situation entirely and is refused outright, before any outbound request, and recovered from
  the console with the new `promote-owner`, `list-servers` and `delete-server` commands.
- Two database constraints now enforce what the code assumed: at most one owner, and at most one Emby
  server. The first closes a race where two simultaneous signups could both become owner. The second
  matters because sign-in resolved "the" Emby server with no defined order, so a second one made the
  authentication authority a coin flip; it now fails closed instead of picking.
- Outbound checks during setup resolve the hostname and validate every address they get back, pin the
  connection to a validated one, and treat any redirect as a failure — a server that answers cannot
  talk Tracearr into probing something else on your network. The same hardening now covers the
  equivalent Plex path, which was the weaker instance of the same thing.

## v1.11.0 — Telegram pairs itself, and CI actually runs

- **Adding a Telegram bot is now a pairing flow.** The old form asked for a bot token and a chat id
  at the same time, which nobody can supply: the chat id does not exist until you have messaged the
  bot. You now paste the token, it is checked against Telegram immediately so a wrong one fails on
  the spot, and Tracearr shows you the bot's own link plus a one-time code. Send the code to the bot
  and the agent is saved. Removing a Telegram agent now also clears its stored token and chat id,
  which it previously left behind.
- **The end-to-end test suite has not run in CI for over a week**, across two releases, and nobody
  could tell because the job failed before reaching a single test. Three separate faults: the dev
  server was started with Node's `--env-file`, which is fatal when the file is missing and `.env` is
  not committed; Turborepo's strict environment mode dropped the database and Redis URLs, so the
  server booted pointing at a database no CI runner has; and underneath both, the Never Watched menu
  added in v1.7.0 gave the sidebar two links matching "Watch", which broke a navigation test. All
  three fixed — the suite now runs 30 tests against a real TimescaleDB and Redis.

## v1.10.0 — watch analytics fixed, updates on Portainer, and Emby-first sign-in

- **Watch analytics worked again.** `/library/watch` and `/library/patterns` were failing on a
  missing relation for anyone whose database role is not a superuser. The cause was three steps
  upstream: TimescaleDB init created an _optional_ extension outside any error handling, that
  statement needs superuser, and its failure skipped everything after it — the sessions hypertable,
  the continuous aggregates, and all seven engagement views. Nothing uses that extension. Compression
  and aggregate creation had the same shape and are guarded too, and a missing aggregate now says so
  in the log instead of failing silently later.
- **The update button works on Docker and Portainer.** A container cannot rebuild itself, so it now
  calls your Portainer stack's redeploy webhook: Portainer re-pulls the image and recreates the stack.
  The webhook URL is a credential, so it is stored write-only and never returned by the API. Note a
  redeploy only changes your version if the stack tracks a moving tag — pinned to an exact version it
  reinstalls the same image, and the UI says so rather than reporting a successful update that did
  nothing.
- **A phantom "update available" that could never be applied is fixed.** The app reports the version
  it was stamped with, not the tag its checkout is on. If those drifted — after a manual upgrade, or a
  restored `.env` — the banner never cleared, because the updater compared the checkout, found it
  current, and exited before correcting the stamp. It now reconciles the stamp when it drifts. The
  manual-update instructions in the README caused this and have been corrected.
- **Never Watched shows library names** instead of raw section keys. The name was always fetched from
  Plex/Jellyfin/Emby and thrown away after logging; it is now stored and kept in step with renames.
- **A "Requested only" filter on Never Watched.** On a real library only about one in eight
  never-watched titles was ever requested, so the "Requested By" column looked permanently empty and
  the items worth acting on were scattered across pages.
- **Requester names link to their profile**, and a failed Emby login now says why — user not found,
  password rejected, or account disabled — rather than a flat "invalid username or password" that
  cannot distinguish a wrong password from a changed one. Emby login errors were also being captured
  and never displayed at all.
- **Once your Emby account is linked, sign-in leads with Emby**, with local sign-in moved behind
  "Other sign-in options". It stays reachable on purpose: Emby login checks live against your Emby
  server, so if that server is down local sign-in is the only way in.
- Security hardening found on the way: `/emby/login` was covered only by the lenient default rate
  limit rather than the strict one guarding the other sign-in routes, and is now bounded properly;
  `TRUST_PROXY=true` trusted every hop, which let a client header pick its own rate-limit bucket
  behind a reverse proxy, so it now takes a hop count or a CIDR list; and the login diagnosis is
  scoped to your own linked account so it cannot be used to enumerate accounts on your Emby server.

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

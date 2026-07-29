#!/usr/bin/env bash
#
# Tracearr self-update (bare-metal / systemd).
#
# Pulls the latest release tag from the configured git remote, reinstalls,
# rebuilds, stamps APP_VERSION, then restarts the tracearr service. Designed to
# be run as its OWN systemd unit (tracearr-update.service) so that restarting
# tracearr.service does not kill this script mid-build.
#
# It writes progress to .update-status.json in the repo root the whole time, so
# the running app (before restart) and the UI can poll GET /version/update/status.
#
# Safety: the build runs to completion BEFORE the restart, so a failed build
# leaves the current version running. No user input is consumed; the target is
# derived from the repo's own tags.
set -uo pipefail

# Re-exec from a stable copy in /tmp before touching the repo: `git checkout` of a
# release that changed this file would otherwise rewrite it mid-run and corrupt the
# still-executing bash. The copy runs to completion regardless of the checkout.
if [ -z "${TRACEARR_UPDATE_REEXEC:-}" ]; then
  _self_copy="$(mktemp /tmp/tracearr-update.XXXXXX.sh)"
  cp "${BASH_SOURCE[0]}" "$_self_copy"
  chmod +x "$_self_copy"
  export TRACEARR_UPDATE_REEXEC=1 TRACEARR_REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  exec "$_self_copy" "$@"
fi

REPO_DIR="${TRACEARR_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# systemd runs this unit with a minimal PATH; node/corepack commonly live in
# /usr/local/bin. Prepend the usual toolchain dirs so git/node/corepack resolve.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
STATUS_FILE="$REPO_DIR/.update-status.json"
LOG_FILE="$REPO_DIR/.update.log"
cd "$REPO_DIR"

# Restart command is overridable for non-systemd hosts / testing.
RESTART_CMD="${TRACEARR_RESTART_CMD:-sudo systemctl restart tracearr.service}"

status() {
  # status(state, message)
  printf '{"state":"%s","message":"%s","at":"%s"}\n' "$1" "$2" "$(date -u +%FT%TZ)" >"$STATUS_FILE"
}

fail() {
  status "failed" "$1"
  echo "[update] FAILED: $1" >>"$LOG_FILE"
  exit 1
}

# The app reports the version it was STAMPED with (APP_VERSION in .env), not the
# version its checkout is on - buildInfo reads /app/.build-info.json in Docker and
# falls back to APP_VERSION everywhere else. So the stamp is the source of truth
# for "what version am I", and keeping it in step with the checkout is this
# script's job.
read_stamped_version() {
  [ -f .env ] || return 0
  # Last assignment wins, matching dotenv precedence.
  grep '^APP_VERSION=' .env | tail -1 | cut -d= -f2-
}

# stamp_version(tag) - write APP_VERSION=<tag without leading v> into .env.
# Rewrite without sed: the version is trusted (validated semver by the caller),
# but a sed s/// on file content is needlessly fragile - rebuild the file instead.
stamp_version() {
  local version="${1#v}"
  if [ -f .env ]; then
    grep -v '^APP_VERSION=' .env >.env.tmp || true
    echo "APP_VERSION=$version" >>.env.tmp
    mv .env.tmp .env
  else
    echo "APP_VERSION=$version" >.env
  fi
}

exec >>"$LOG_FILE" 2>&1
echo "=== update run $(date -u +%FT%TZ) ==="

status "running" "Fetching latest release"
git fetch --tags --prune origin || fail "git fetch failed"

# Latest STABLE tag by version sort (excludes alpha/beta/rc prereleases).
TARGET="$(git tag -l 'v*' | grep -viE '\-(alpha|beta|rc|next|dev|canary)' | sort -V | tail -1)"
[ -n "$TARGET" ] || fail "no release tag found"
# Validate before the tag is used anywhere (checkout, sed-free stamp, status JSON).
# A ref name legally allows / ; & $ ( ) ' " etc.; an unvalidated tag is a code-exec
# vector via sed and breaks the status JSON. Semver-only closes all of it.
[[ "$TARGET" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "unexpected tag name: $TARGET"
CURRENT="$(git describe --tags --always 2>/dev/null || echo unknown)"
echo "[update] current=$CURRENT target=$TARGET"

if [ "$CURRENT" = "$TARGET" ]; then
  # The checkout is already on the target, but APP_VERSION can still disagree
  # with it: the app reads its version from that stamp, not from git, so a
  # manual deploy (checkout + build + restart, bypassing this script), a
  # restored .env, or a run that died between checkout and stamp leaves the UI
  # reporting an old version and offering an update forever - while this path
  # keeps answering "already up to date" and never repairs it. Reconcile the
  # stamp here so the loop is self-healing, and restart only when it actually
  # changed (this path runs on every update click).
  if [ "$(read_stamped_version)" != "${TARGET#v}" ]; then
    echo "[update] stamp drift: .env has '$(read_stamped_version)', checkout is $TARGET"
    status "running" "Reconciling version stamp to $TARGET"
    stamp_version "$TARGET"
    status "restarting" "Restarting on $TARGET"
    $RESTART_CMD || fail "restart failed (stamp reconciled to $TARGET; run: $RESTART_CMD)"
    status "done" "Reconciled version stamp to $TARGET"
    echo "[update] stamp reconciled -> $TARGET"
    exit 0
  fi
  status "done" "Already on $TARGET"
  echo "[update] already up to date"
  exit 0
fi

status "running" "Checking out $TARGET"
git checkout -f "$TARGET" || fail "checkout $TARGET failed"

status "running" "Installing dependencies"
CI=true corepack pnpm install --frozen-lockfile || fail "pnpm install failed"

status "running" "Building"
corepack pnpm build || fail "build failed"

# Stamp the version so the update checker compares correctly after restart.
stamp_version "$TARGET"

# Point of no return: everything built. Migrations run on the new process start.
status "restarting" "Restarting on $TARGET"
echo "[update] restarting service -> $TARGET"
$RESTART_CMD || fail "restart failed (built $TARGET; run: $RESTART_CMD)"

status "done" "Updated to $TARGET"
echo "[update] done -> $TARGET"

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

exec >>"$LOG_FILE" 2>&1
echo "=== update run $(date -u +%FT%TZ) ==="

status "running" "Fetching latest release"
git fetch --tags --prune origin || fail "git fetch failed"

# Latest STABLE tag by version sort (excludes alpha/beta/rc prereleases).
TARGET="$(git tag -l 'v*' | grep -viE '\-(alpha|beta|rc|next|dev|canary)' | sort -V | tail -1)"
[ -n "$TARGET" ] || fail "no release tag found"
CURRENT="$(git describe --tags --always 2>/dev/null || echo unknown)"
echo "[update] current=$CURRENT target=$TARGET"

if [ "$CURRENT" = "$TARGET" ]; then
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
VERSION="${TARGET#v}"
if grep -q '^APP_VERSION=' .env 2>/dev/null; then
  sed -i "s/^APP_VERSION=.*/APP_VERSION=$VERSION/" .env
else
  echo "APP_VERSION=$VERSION" >>.env
fi

# Point of no return: everything built. Migrations run on the new process start.
status "restarting" "Restarting on $TARGET"
echo "[update] restarting service -> $TARGET"
$RESTART_CMD || fail "restart failed (built $TARGET; run: $RESTART_CMD)"

status "done" "Updated to $TARGET"
echo "[update] done -> $TARGET"

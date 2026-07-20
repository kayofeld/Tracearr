# PR 2 — ready to open (Paul opens it; do not auto-open)

**From:** `kayofeld:feat/users-remove-and-resync` → **To:** `connorgallopo:main`
**Open at:** https://github.com/connorgallopo/Tracearr/compare/main...kayofeld:Tracearr:feat/users-remove-and-resync

Note: upstream asks for features to be discussed first (Discussions/Discord). This one is
small and fixes a felt pain (stale rosters), so a short Discussion note or opening the PR
directly with the motivation up front are both defensible — your call.

**Title:**

```
Add bulk user removal and a Sync users action to the roster
```

**Body (paste below):**

```markdown
## Summary

Users deleted on a media server stay visible in Tracearr until the next user sync, and user sync only runs automatically when a server is added. The existing force-sync (`POST /servers/:id/sync`) soft-removes accounts that disappeared from the server, but it is only reachable from Server Settings. This PR makes stale rosters fixable from the Users page itself: an owner can remove selected accounts directly, or trigger a sync of all servers in place.

## Type of Change

- [ ] Bug fix
- [x] New feature
- [ ] Documentation
- [ ] Refactor
- [ ] Breaking change

## Related Issue

None filed — motivated by running Tracearr against an Emby server where deleted accounts lingered in the roster.

## Changes

- New `POST /users/bulk/remove` (owner-only, explicit uuids, min 1 / max 1000, no selectAll by design): sets `removedAt` on the selected server users — the same soft-remove a sync applies, so session history is preserved, "Show removed" still lists them, and a later sync restores accounts that still exist on the server.
- "Remove users" destructive bulk action with a confirm dialog on the Users page; disabled in select-all mode and for selections over 1000.
- Owner-only "Sync users" button in the Users page header, reusing the existing per-server sync endpoint and hook.
- Route tests for the new endpoint (owner gate, zod validation, idempotency); translation keys added and propagated to all locales (English defaults, ready for Crowdin).

## Screenshots

(UI additions: a "Sync users" outline button in the page header, and a destructive "Remove users" entry in the bulk-actions toolbar with a confirmation dialog.)

## Testing

- [x] Added/updated unit tests
- [x] Ran test suite locally (`pnpm test:unit`)
- [x] Tested manually

Local: 549 route tests pass (5 new), 145 web tests pass, `tsc --noEmit` clean on server and web, production web build passes, `translations:check` green.

## AI Disclosure

- [x] AI tools were used significantly in writing this code

Implemented with Claude Code following the existing bulk/reset-trust and sync patterns; independently security-reviewed (owner gate fail-closed on both auth paths, `removedAt` semantics checked against poller/session-lifecycle/inactivity-rule/trust-aggregation consumers, no selectAll on the destructive path).

## Checklist

- [x] Code follows project style (ran `pnpm lint` and `pnpm format`)
- [x] Self-reviewed
- [x] No new warnings from `pnpm typecheck`
- [x] Tests pass locally
```

**Reviewer notes (not part of the PR body):** the independent review returned GO with three
accepted-as-is observations, worth knowing if the maintainer asks: (a) the "Sync users"
button fires one mutation per server; TanStack tracks only the last one, so the spinner can
clear early with many servers — harmless (sync converges, verified), polish later; (b)
`updatedAt` is not touched on removal, matching sync's own remove path (reset-trust differs);
(c) for Plex accounts whose row was poller-created without a `plexAccountId`, sync can
neither auto-remove nor auto-restore them — the dialog copy says "usually restored" for this
reason; a username-fallback match in sync would be the real fix and is a separate issue.

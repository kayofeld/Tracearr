# ADR 0005: Ombi API key stored plaintext in settings, following repo convention

**Status:** Accepted
**Date:** 2026-07-28
**Deciders:** software-architect (convention pre-verified by coordinator scout)

## Context

The connector needs a persisted Ombi API key. The repository's established convention stores
integration secrets **plaintext** in the `settings` jsonb kv table: `tautulliApiKey`,
`telegramBotToken`, `pushoverApiToken`, `ntfyAuthToken` all live in `PUBLIC_DEFAULTS`
(`services/settings.ts:14-45`) and are returned to the owner by the owner-gated settings
endpoint. `utils/crypto.ts` is deprecated and decrypt-only; new tokens are deliberately
plaintext. Inventing per-feature encryption would diverge from the codebase and add key-
management complexity without a threat-model payoff (an attacker who can read the settings
table almost certainly has the app's DB credentials and, in this single-owner homelab
deployment, effectively everything else).

The Ombi API key is a high-value credential on its own axis: it grants **full admin** on the
Ombi instance (user management, request approval), which is publicly reachable at
`https://ombi.draner.pet`.

## Decision

Store `ombiApiKey` plaintext in the settings kv table, exactly like `tautulliApiKey`:
present in `PUBLIC_DEFAULTS`, readable/writable only through the owner-gated settings
endpoints. Do **not** introduce encryption-at-rest for this key. Compensating requirements
(binding on the build):

- The key must be **redacted in all logs and error messages** (model:
  `jobs/telegramCommandListener.ts`), including HTTP client errors that may echo headers.
- The key never appears in any response other than the owner-gated settings read (no status,
  mapping, stats, or WS payload includes it).
- The key is sent only in the `ApiKey` header to the configured `ombiUrl`, after
  `assertSafeProbeUrl()`.

## Options considered

1. **Plaintext in settings, owner-gated + log redaction (chosen)** — pros: matches every
   existing integration secret, zero new machinery, honest about the actual trust boundary
   (the DB); cons: DB dumps/backups contain a live Ombi admin credential.
2. **Encrypt with an app-managed key (revive `utils/crypto.ts`)** — pros: opaque at rest;
   cons: the decryption key sits next to the ciphertext (env/config), so it defeats only the
   casual-backup-reader; contradicts the repo's explicit deprecation of that path; adds
   rotation/migration burden for one key.
3. **Env-var only (never persisted)** — pros: out of the DB; cons: violates the repo's
   settings-not-env convention for optional integrations and breaks UI-driven configuration,
   which is a core requirement of the feature.

## Consequences

- Positive: consistency (one mental model for all integration secrets); no new crypto
  surface to review; UI-configurable as required.
- Negative / trade-offs: Tracearr DB backups now embed an admin credential for a publicly
  reachable Ombi. Owner-facing docs should say so and recommend (a) treating Tracearr
  backups as secret material — already true given the other tokens — and (b) rotating the
  Ombi key if a backup leaks.
- Follow-ups: if the project ever adds encryption-at-rest for settings secrets, `ombiApiKey`
  joins that migration wholesale — nothing in this design assumes plaintext beyond the
  storage call itself. Flag to coordinator: this ADR _follows_ convention rather than
  endorsing it as ideal; a repo-wide secrets-at-rest decision is out of this feature's scope.

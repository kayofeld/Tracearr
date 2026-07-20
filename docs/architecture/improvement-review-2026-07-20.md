# Tracearr server — improvement review (2026-07-20)

Independent Fable review, improvement lens (read-only). Scope: server ingestion pipeline,
rules engine, data layer, cross-cutting concerns, tests, and a light frontend pass.

**Bottom line:** the core is genuinely well-engineered. Improvements are mostly about
_size/complexity concentration_, _consistency_ (logging, config, error handling), and a few
security sharp edges — not correctness rewrites. One HIGH security item was found and **already
fixed** (X3, image-proxy token leak — merged `c4a8943b`).

## What's notably good (leave alone)

- **Poller concurrency model** (`jobs/poller/processor.ts`): per-server mutex + reentrancy guards
  - grace-period two-poll stop confirmation, documented with the race each prevents.
- **Fail-safe ingestion**: degrade-to-polling everywhere, `unhandledRejection` keep-alive net,
  maintenance-gate before the rate limiter.
- **TimescaleDB versioned aggregates + advisory-locked backfill** (`db/timescale.ts`) — the
  strongest part of the codebase.
- **SSRF helper** (`utils/ssrf.ts`), **SERIALIZABLE + retry** on session create, **rules-v2
  evaluator registry** (`services/rules/evaluators/index.ts`).

## Ranked improvement backlog (value-for-effort)

| #   | Finding                                                                                                               | Area          | Impact | Effort | Status             |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------- | ------ | ------ | ------------------ |
| 1   | **X3** Image-proxy token exfiltration + unauth SSRF                                                                   | Security      | HIGH   | S      | ✅ DONE `c4a8943b` |
| 2   | **F1** Route-level `lazy()` + `manualChunks` (initial chunk ~500KB → 152KB / 44KB gzip)                               | Frontend      | MED    | S      | ✅ DONE `0623392a` |
| 3   | **I1** Split the ~2300-line `processor.ts`; dedupe the twice-repeated create block (~lines 866-1075 & 1169-1300)      | Ingestion     | HIGH   | L      | todo               |
| 4   | **X2** Central typed `config.ts` (zod) — collapse 202 ad-hoc `process.env` reads, fail-fast at boot                   | Cross-cutting | MED    | M      | todo               |
| 5   | **X1** Standardize on pino/structured logging; retire 657 `console.*` (do after I1/I2)                                | Cross-cutting | MED    | M      | todo               |
| 6   | **I5** Collapse dual V1 (`services/rules.ts`) / V2 (`services/rules/`) rules systems, or document the split hard      | Rules         | MED    | M      | todo               |
| 7   | **T1** Real Postgres+Redis integration tests for grace-period stop + poller/SSE create race                           | Tests         | MED    | M      | todo               |
| 8   | **I7** Move plain B-tree/partial indexes into numbered migrations; keep only Timescale-specific DDL in `timescale.ts` | Data          | MED    | M      | todo               |
| 9   | **I2/I3** Split `sessionLifecycle.ts` builders from transactions; share ingest orchestration between poller & SSE     | Ingestion     | MED    | M      | todo               |
| 10  | **I8** Replace `sql.raw`/hand-built WHERE in query routes with Drizzle conditions                                     | Data          | MED    | M      | todo               |

Quick wins to bundle: **I6** table-driven test asserting every `ConditionField` has a registered
evaluator (missing evaluator silently disables a rule); **I9** completion marker on the startup
token-migration loop; **F1**'s prod-sourcemap decision (`vite.config.ts build.sourcemap: true` ships
source publicly).

## Notes

- The improvement lens still surfaced X3 (a real HIGH security bug) — keep the security-reviewer on
  improvement passes for exactly that reason.
- Several findings (I1/I2/X1) are mechanical and de-risked by the existing large `__tests__/` suite;
  sequence them so each hot-path block is touched once (split → then re-log).

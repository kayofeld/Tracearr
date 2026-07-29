/**
 * Emby-native first-run setup (Better Auth plugin).
 *
 * POST /emby/setup (path constant EMBY_SETUP_PATH, @tracearr/shared) lets the
 * very first user of a fresh Tracearr instance establish their Emby server
 * and create the owner account using their Emby credentials, instead of
 * inventing a separate local password. Full design:
 * docs/architecture/emby-native-setup.md (revision 2).
 *
 * This is a separate file from embyPlugin.ts on purpose (design §6.1): it
 * keeps embyPlugin.ts's "only credentials are accepted here, never a client
 * URL" property verifiable at a glance, because a client-supplied
 * `serverUrl` is accepted by exactly ONE endpoint instance-wide, and only
 * while the instance is `unclaimed` (authGuards.ts's getInstanceClaimState()).
 *
 * `runEmbySetup` below is the pure orchestration core: every piece of I/O is
 * an injected port, so the full state-gate / verification / compensation
 * flow is unit-testable with no database, no Emby server, and no Better Auth
 * instance (see __tests__/embySetupPlugin.test.ts). `embySetupPlugin()` is
 * the thin wiring layer that supplies the real ports plus the two
 * process-global bounds (concurrency slot, rate limit) that aren't part of
 * the pure per-request logic.
 */

import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import {
  EMBY_SETUP_PATH,
  pickServerColor,
  type EmbySetupResult,
  type EmbySetupErrorCode,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, authAccounts } from '../db/schema.js';
import { EmbyClient } from '../services/mediaServer/index.js';
import { asJsonFetcher } from '../utils/safeProbe.js';
import { assertSafeProbeUrl, SsrfBlockedError } from '../utils/ssrf.js';
import {
  isUniqueViolationOn,
  USERS_SINGLE_OWNER_CONSTRAINT,
  SERVERS_SINGLE_EMBY_CONSTRAINT,
} from '../utils/dbErrors.js';
import { createLogger } from '../utils/logger.js';
import {
  getInstanceClaimState,
  OWNERLESS_INSTANCE_RECOVERY_MESSAGE,
  OWNERLESS_INSTANCE_LOG_MARKER,
  type InstanceClaimState,
} from './authGuards.js';

const EMBY_PROVIDER = 'emby';
const logger = createLogger('embySetupPlugin');

// ============================================================================
// Bounds (SEC-07 fix, design §9) - server-side constants, never derived from
// the request.
// ============================================================================

export const SETUP_RATE_LIMIT = { window: 60, max: 5 } as const;
export const MAX_CONCURRENT_SETUP_PROBES = 2;
export const SETUP_PROBE_TIMEOUT_MS = 5_000;
export const SETUP_TOTAL_BUDGET_MS = 15_000;

let activeSetupProbes = 0;

/** Acquires one of MAX_CONCURRENT_SETUP_PROBES slots. Returns false if none are free. */
export function acquireSetupProbeSlot(): boolean {
  if (activeSetupProbes >= MAX_CONCURRENT_SETUP_PROBES) return false;
  activeSetupProbes += 1;
  return true;
}

export function releaseSetupProbeSlot(): void {
  activeSetupProbes = Math.max(0, activeSetupProbes - 1);
}

/** Test-only: resets the in-process concurrency counter between test cases. */
export function resetSetupProbeSlotsForTests(): void {
  activeSetupProbes = 0;
}

// ============================================================================
// URL canonicalization (SEC-09 fix, design §6.2 step 4 / §8.4)
// ============================================================================

export class SetupUrlRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupUrlRejectedError';
  }
}

/**
 * Parses and canonicalizes the client-supplied Emby server URL: rejects
 * anything unparseable, a non-http(s) scheme, userinfo, a query string, a
 * fragment, or a path beyond `/`; returns the origin (scheme + lowercased
 * host + non-default port only). The canonical origin is what gets probed,
 * stored and echoed - the raw input is never stored and never appears in an
 * error string (SEC-09). A URL carrying userinfo is rejected outright rather
 * than stripped, because silently accepting it teaches the operator that
 * pasting credentials into the field is fine.
 */
export function canonicalizeSetupUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SetupUrlRejectedError('Malformed URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SetupUrlRejectedError('Only http and https URLs are allowed.');
  }
  if (parsed.username || parsed.password) {
    throw new SetupUrlRejectedError('The URL must not contain a username or password.');
  }
  if (parsed.search) {
    throw new SetupUrlRejectedError('The URL must not contain a query string.');
  }
  if (parsed.hash) {
    throw new SetupUrlRejectedError('The URL must not contain a fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new SetupUrlRejectedError('The URL must not contain a path.');
  }
  return parsed.origin;
}

// ============================================================================
// The pure orchestration core
// ============================================================================

const setupBody = z.object({
  serverUrl: z.string().min(1),
  serverName: z.string().optional(),
  apiKey: z.string().min(1),
  username: z.string().min(1),
  password: z.string(),
  claimCode: z.string().optional(),
});

export type EmbySetupInput = z.infer<typeof setupBody>;

export class EmbySetupError extends Error {
  readonly code: EmbySetupErrorCode;
  readonly httpStatus: number;
  constructor(code: EmbySetupErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'EmbySetupError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface VerifyAdminResult {
  success: boolean;
  code?: string;
  message?: string;
}

interface AuthenticateResult {
  id: string;
  token: string;
  isAdmin: boolean;
}

/** Every piece of I/O runEmbySetup needs, injected so the flow is unit-testable without a DB/Emby/Better Auth instance. */
export interface EmbySetupPorts {
  getClaimState(): Promise<InstanceClaimState>;
  verifyServerAdmin(apiKey: string, url: string): Promise<VerifyAdminResult>;
  authenticate(url: string, username: string, password: string): Promise<AuthenticateResult | null>;
  createOwnerUser(username: string): Promise<{ id: string }>;
  insertServer(input: {
    name: string;
    url: string;
    token: string;
  }): Promise<{ id: string; name: string; url: string }>;
  linkEmbyAccount(input: { userId: string; accountId: string; accessToken: string }): Promise<void>;
  createSession(userId: string): Promise<{ token: string } | null>;
  deleteServer(serverId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  logError(message: string, context?: Record<string, unknown>): void;
}

const FIXED_URL_REJECTED_MESSAGE = 'The server URL is invalid or not permitted.';
const FIXED_SERVER_UNREACHABLE_MESSAGE = 'Could not reach the Emby server.';

/**
 * The `owned`/`ownerless-with-data` refusal, both of which are unconditional
 * and precede any outbound call - shared by `runEmbySetup`'s own gate AND the
 * HTTP endpoint's pre-slot-acquisition check (CR-10/IMP-11 below), so both
 * call sites agree on the exact code/message and neither drifts from the
 * other. Returns `null` for `unclaimed` (nothing to refuse here).
 */
function claimStateRefusal(state: InstanceClaimState): EmbySetupError | null {
  if (state === 'owned') {
    return new EmbySetupError(
      'INSTANCE_OWNED',
      403,
      'This Tracearr instance already has an owner. Only the owner can log in.'
    );
  }
  if (state === 'ownerless-with-data') {
    // CR-3/IMP-01 (console-only recovery, owner decision - design §3/§6.3 as
    // amended): this state refuses UNCONDITIONALLY and before any outbound
    // call - no claim-code check, no attempt to resolve an existing Emby
    // server row, no probe of the operator's Emby server, and their
    // credentials for this request are never sent anywhere. There is no
    // network adoption path for an ownerless-but-populated instance, full
    // stop; the fixed message names the CLI-only recovery (matches
    // authGuards.ts's assertSignupAllowed/assertOAuthSignupClaimCode, which
    // refuse the same state the same way - every claim path now agrees).
    return new EmbySetupError('INSTANCE_RECOVERY', 403, OWNERLESS_INSTANCE_RECOVERY_MESSAGE);
  }
  return null;
}

/**
 * The full setup flow (design §6.2/§6.3), state-gated and compensated. No
 * upstream status/status text/body ever reaches a thrown message (SEC-03c) -
 * `ports.verifyServerAdmin`/`authenticate` are expected to have already
 * scrubbed that (EmbyClient's existing behavior, unchanged), and this
 * function itself never echoes anything from `ports` back into an
 * EmbySetupError message beyond the fixed strings below.
 */
export async function runEmbySetup(
  input: EmbySetupInput,
  ports: EmbySetupPorts
): Promise<EmbySetupResult> {
  // CR-9/IMP-06: a per-attempt correlation id for the compensation-failure
  // log below - minted here (not threaded in from the HTTP layer) so this
  // function stays pure/ctx-free and unit-testable with no request object.
  const requestId = randomUUID();
  const state = await ports.getClaimState();

  const refusal = claimStateRefusal(state);
  if (refusal) {
    if (state === 'ownerless-with-data') {
      ports.logError(
        `${OWNERLESS_INSTANCE_LOG_MARKER}: refused /emby/setup - instance holds data but has no owner`
      );
    }
    throw refusal;
  }

  let canonicalUrl: string;
  try {
    canonicalUrl = canonicalizeSetupUrl(input.serverUrl);
  } catch {
    throw new EmbySetupError('URL_REJECTED', 400, FIXED_URL_REJECTED_MESSAGE);
  }

  // CR-7 fix: a denied LITERAL address (e.g. the cloud metadata IP,
  // 169.254.169.254) must map to 400 URL_REJECTED (design §6.4 row 4), not
  // 503 SERVER_UNREACHABLE. Without this explicit pre-check, the denial only
  // ever surfaced deep inside safeProbeJson's own literal pre-flight
  // (`ProbeBlockedError`), which EmbyClient.verifyServerAdmin's broad
  // connectivity-check `catch` swallows into the generic CONNECTION_FAILED
  // code (it does not distinguish a blocked URL from an actually-unreachable
  // one) - so the client saw a misleading "server unreachable" instead of
  // "URL rejected", and never before any outbound call as the fixed-URL path
  // above already guarantees. Checked here, synchronously, before any port
  // is touched.
  try {
    assertSafeProbeUrl(canonicalUrl);
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      throw new EmbySetupError('URL_REJECTED', 400, FIXED_URL_REJECTED_MESSAGE);
    }
    throw err;
  }

  const adminCheck = await ports.verifyServerAdmin(input.apiKey, canonicalUrl);
  if (!adminCheck.success) {
    if (adminCheck.code === EmbyClient.AdminVerifyError.CONNECTION_FAILED) {
      throw new EmbySetupError('SERVER_UNREACHABLE', 503, FIXED_SERVER_UNREACHABLE_MESSAGE);
    }
    if (adminCheck.code === EmbyClient.AdminVerifyError.INVALID_KEY) {
      throw new EmbySetupError('KEY_REJECTED', 401, 'Emby rejected this API key.');
    }
    throw new EmbySetupError(
      'KEY_NOT_ADMIN',
      403,
      'This API key does not have administrator access on this Emby server.'
    );
  }

  const authResult = await ports.authenticate(canonicalUrl, input.username, input.password);
  if (!authResult) {
    throw new EmbySetupError('BAD_CREDENTIALS', 401, 'Invalid Emby username or password.');
  }
  if (!authResult.isAdmin) {
    throw new EmbySetupError(
      'NOT_EMBY_ADMIN',
      403,
      'Only an Emby administrator can set up Tracearr.'
    );
  }

  let createdUser: { id: string } | null = null;
  let insertedServerId: string | null = null;

  try {
    try {
      createdUser = await ports.createOwnerUser(input.username);
    } catch (err) {
      if (isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)) {
        // Race lost - nothing was created for this attempt, so there is
        // nothing to compensate (design §6.4 row "7a").
        throw new EmbySetupError(
          'INSTANCE_OWNED',
          403,
          'This Tracearr instance already has an owner. Only the owner can log in.'
        );
      }
      throw err;
    }

    const serverName = input.serverName?.trim() || 'Emby';
    const serverResult = await ports.insertServer({
      name: serverName,
      url: canonicalUrl,
      token: input.apiKey,
    });
    insertedServerId = serverResult.id;

    await ports.linkEmbyAccount({
      userId: createdUser.id,
      accountId: authResult.id,
      accessToken: authResult.token,
    });

    const session = await ports.createSession(createdUser.id);
    if (!session) {
      throw new Error('Failed to create session after Emby setup');
    }

    return {
      authorized: true,
      user: { id: createdUser.id, username: input.username, role: 'owner' },
      server: serverResult,
    };
  } catch (err) {
    if (err instanceof EmbySetupError) throw err;

    // IMP-05: `servers_single_emby` (the single-Emby product rule, owner
    // decision 3) was unmapped here - a race against a server row created
    // through another path (e.g. an operator using POST /servers directly
    // between this attempt's state check and its own insertServer call)
    // fell through to the generic SETUP_FAILED below and surfaced as a raw
    // 500. Determined up front so compensation below still runs unchanged
    // (this attempt's own user row is deleted; no server to delete - this
    // attempt never inserted one), and only the FINAL thrown code differs:
    // INSTANCE_RECOVERY names the actual resulting state accurately - a
    // servers row now exists with no owner, console-only recovery, same as
    // the ownerless-with-data branch above.
    const isServerConflict = isUniqueViolationOn(err, SERVERS_SINGLE_EMBY_CONSTRAINT);

    // CR-9/IMP-06: log the ORIGINAL cause of this SETUP_FAILED. Without this,
    // the root reason the flow broke (e.g. a real DB error from insertServer)
    // was visible only if compensation ALSO failed (the "INSTANCE REQUIRES
    // MANUAL RECOVERY" logs further down cover only THAT failure) - the
    // common case of a clean compensation left no trace of why setup failed
    // in the first place.
    //
    // NEW-01: this used to log `err.message` as a plain string. For a
    // `DrizzleQueryError` (drizzle-orm/errors.js), the message text itself is
    // `Failed query: <sql>\nparams: <params>` - the bound query parameters
    // (insertServer binds the operator's Emby admin API key, linkEmbyAccount
    // binds the Emby access token) live INSIDE that string, not only on the
    // separate `.params` property. Passing a bare string bypassed the
    // logger's Error-shape rebuild entirely (`redactValue` only rebuilt the
    // message when handed the Error object), so the raw secret-bearing text
    // reached stdout on any driver-level failure here. Passing the error
    // object itself lets `redactValue` do the rebuild (and now also strips
    // the same tail from any plain string, closing the gap for good - see
    // logger.ts).
    ports.logError('Emby setup failed - compensating', {
      requestId,
      claimState: state,
      err,
    });

    // Compensation (design §7.3): reverse order. Compensation failures never
    // mask the original error - the request still surfaces as SETUP_FAILED
    // below - but the recovery log CR-5 fixes to name the command that
    // matches what actually survives, computed only after BOTH deletes have
    // been attempted (which artifact(s) survive isn't knowable until then):
    // the owner user row (createOwnerUser's before-hook sets role='owner' at
    // creation) surviving means the instance is `owned`, already recoverable
    // with `reset-password`, no promotion needed; only the server row
    // surviving (the common case this bug produces: user delete succeeds,
    // server delete fails) leaves ZERO user rows, so `promote-owner` has
    // nothing to promote and the real remedy is deleting the server row.
    let serverDeleteError: unknown;
    let userDeleteError: unknown;
    if (insertedServerId) {
      await ports.deleteServer(insertedServerId).catch((cleanupErr: unknown) => {
        serverDeleteError = cleanupErr;
      });
    }
    if (createdUser) {
      await ports.deleteUser(createdUser.id).catch((cleanupErr: unknown) => {
        userDeleteError = cleanupErr;
      });
    }
    if (userDeleteError) {
      ports.logError(
        'INSTANCE REQUIRES MANUAL RECOVERY: failed to delete the orphaned owner user row after ' +
          'a failed Emby setup attempt. The instance now has an owner with no working login - ' +
          'recover with `pnpm --filter @tracearr/server cli reset-password <username>`.',
        { err: userDeleteError }
      );
    }
    if (serverDeleteError) {
      ports.logError(
        'INSTANCE REQUIRES MANUAL RECOVERY: failed to delete the orphaned Emby server row after ' +
          'a failed Emby setup attempt.' +
          (userDeleteError
            ? ''
            : ' No user row survives to promote - recover with ' +
              '`pnpm --filter @tracearr/server cli list-servers` and `cli delete-server <id>`.'),
        { err: serverDeleteError }
      );
    }
    if (isServerConflict) {
      throw new EmbySetupError('INSTANCE_RECOVERY', 403, OWNERLESS_INSTANCE_RECOVERY_MESSAGE);
    }
    throw new EmbySetupError('SETUP_FAILED', 500, 'Failed to complete setup.');
  }
}

// ============================================================================
// Real ports + Better Auth wiring
// ============================================================================

type SetupEndpointCtx = Parameters<typeof setSessionCookie>[0];

async function createSetupSession(ctx: SetupEndpointCtx, userId: string) {
  const session = await ctx.context.internalAdapter.createSession(userId);
  if (!session) return null;
  const user = await ctx.context.internalAdapter.findUserById(userId);
  if (!user) return null;
  await setSessionCookie(ctx, { session, user });
  return session;
}

/**
 * `totalBudgetSignal` is built and owned by the endpoint handler (CR-13/
 * IMP-10 fix), not here: the handler's own `finally` clears the underlying
 * timer once the request is done, success or failure. Building it inside
 * this function with no reference returned to the caller meant the endpoint
 * could never clear it - a harmless-but-sloppy leftover timer per request
 * (its own `.unref()` keeps it from blocking process exit, but it still
 * fires pointlessly ~15s after every already-completed request).
 */
function buildRealPorts(ctx: SetupEndpointCtx, totalBudgetSignal: AbortSignal): EmbySetupPorts {
  const fetchImpl = asJsonFetcher({
    timeoutMs: SETUP_PROBE_TIMEOUT_MS,
    signal: totalBudgetSignal,
    onUpstreamError: (detail) => {
      logger.error('Emby setup probe failed', detail);
    },
  });

  return {
    getClaimState: getInstanceClaimState,
    verifyServerAdmin: (apiKey, url) => EmbyClient.verifyServerAdmin(apiKey, url, fetchImpl),
    authenticate: (url, username, password) =>
      EmbyClient.authenticate(url, username, password, fetchImpl),
    createOwnerUser: async (username) => {
      // internalAdapter.createUser's TS type requires `email: string` (better-auth's
      // base User schema has no nullable-email variant), but nothing at runtime
      // requires the key: the hook chain and the drizzle adapter both handle a
      // missing/undefined email fine (users.email has no NOT NULL/default - see
      // db/schema.ts), same cast precedent as signupPlugin.ts's no-email path.
      const created = await ctx.context.internalAdapter.createUser({
        name: username,
        username,
      } as unknown as Parameters<typeof ctx.context.internalAdapter.createUser>[0]);
      return { id: (created as unknown as { id: string }).id };
    },
    insertServer: async ({ name, url, token }) => {
      const existingColors = await db.select({ color: servers.color }).from(servers);
      const color = pickServerColor(
        'emby',
        existingColors.map((s) => s.color)
      );
      const [inserted] = await db
        .insert(servers)
        .values({ name, type: 'emby', url, token, color })
        .returning({ id: servers.id, name: servers.name, url: servers.url });
      if (!inserted) throw new Error('Failed to insert Emby server row');
      return inserted;
    },
    linkEmbyAccount: async ({ userId, accountId, accessToken }) => {
      await db.insert(authAccounts).values({
        id: randomUUID(),
        accountId,
        providerId: EMBY_PROVIDER,
        userId,
        accessToken,
      });
    },
    createSession: (userId) => createSetupSession(ctx, userId),
    deleteServer: async (serverId) => {
      await db.delete(servers).where(eq(servers.id, serverId));
    },
    deleteUser: async (userId) => {
      await ctx.context.internalAdapter.deleteUser(userId);
    },
    logError: (message, context) => logger.error(message, context),
  };
}

export const embySetupPlugin = () =>
  ({
    id: 'emby-setup',
    endpoints: {
      embySetup: createAuthEndpoint(
        EMBY_SETUP_PATH,
        { method: 'POST', body: setupBody },
        async (ctx) => {
          // CR-10/IMP-11: check the claim state BEFORE ever acquiring a
          // concurrency slot. `owned` and `ownerless-with-data` both refuse
          // unconditionally with no outbound Emby call at all
          // (claimStateRefusal/runEmbySetup above), so neither should ever
          // compete for - or be blocked by - the slot pool that exists
          // specifically to bound outbound probes (SEC-07, design §9). Before
          // this fix, an already-`owned` instance under concurrent setup-probe
          // load from unrelated attempts could be wrongly told `BUSY` instead
          // of its real, instant `INSTANCE_OWNED`. `runEmbySetup` re-derives
          // the SAME state right after (one more cheap DB read) as the
          // authoritative check - this is a fast-path short-circuit sharing
          // the exact same `claimStateRefusal` logic, not a second authority.
          const earlyState = await getInstanceClaimState();
          const earlyRefusal = claimStateRefusal(earlyState);
          if (earlyRefusal) {
            throw new APIError(httpStatusToApiStatus(earlyRefusal.httpStatus), {
              message: earlyRefusal.message,
              code: earlyRefusal.code,
            });
          }

          if (!acquireSetupProbeSlot()) {
            // better-call's APIError(status, body) writes `body` verbatim as
            // the wire response (see better-call/dist/to-response.mjs:
            // `toResponse(data.body, ...)`) - `code` MUST be a top-level key
            // of the 2nd arg, never nested under its own `body` key, or the
            // client's `error.code` switch (Login.tsx) never matches and every
            // setup error falls back to this English prose (CR-1).
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: 'Too many setup attempts are already in progress. Try again shortly.',
              code: 'BUSY',
            });
          }

          // CR-13/IMP-10: owned by this handler (not buildRealPorts) so the
          // `finally` below can `clearTimeout` it once the request is done,
          // success or failure, instead of leaving it to fire pointlessly
          // ~15s later on an already-finished request every time.
          const totalBudgetController = new AbortController();
          const budgetTimer = setTimeout(
            () => totalBudgetController.abort(),
            SETUP_TOTAL_BUDGET_MS
          );
          budgetTimer.unref();

          try {
            const result = await runEmbySetup(
              ctx.body,
              buildRealPorts(ctx, totalBudgetController.signal)
            );
            return ctx.json(result);
          } catch (err) {
            if (err instanceof EmbySetupError) {
              throw new APIError(httpStatusToApiStatus(err.httpStatus), {
                message: err.message,
                code: err.code,
              });
            }
            logger.error('Unexpected error in /emby/setup', { err });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to complete setup.',
              code: 'SETUP_FAILED',
            });
          } finally {
            clearTimeout(budgetTimer);
            releaseSetupProbeSlot();
          }
        }
      ),
    },
  }) satisfies BetterAuthPlugin;

/** Maps the small set of HTTP statuses EmbySetupError actually uses to better-auth's APIError status names. */
function httpStatusToApiStatus(
  status: number
): 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE' | 'INTERNAL_SERVER_ERROR' {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 503:
      return 'SERVICE_UNAVAILABLE';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

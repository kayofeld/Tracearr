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
import { isUniqueViolationOn, USERS_SINGLE_OWNER_CONSTRAINT } from '../utils/dbErrors.js';
import { createLogger } from '../utils/logger.js';
import { isClaimCodeEnabled } from '../utils/claimCode.js';
import {
  getInstanceClaimState,
  OWNERLESS_INSTANCE_RECOVERY_MESSAGE,
  OWNERLESS_INSTANCE_LOG_MARKER,
  type InstanceClaimState,
} from './authGuards.js';
import { resolveConfiguredEmbyServerRow } from './embyPlugin.js';

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
  /**
   * Whether a claim code is configured at all (CLAIM_CODE env var set). The
   * centralized hook in auth.ts already enforces a CONFIGURED code being
   * correct before this function ever runs; this port covers the narrower
   * case design §3 calls out separately: in `ownerless-with-data`, the code
   * is required UNCONDITIONALLY, so an instance with no code configured at
   * all must refuse rather than let the hook's usual "disabled means no-op"
   * behavior wave the request through.
   */
  isClaimCodeConfigured(): boolean;
  /** Resolves the existing Emby server row for the ownerless-with-data recovery branch. May throw AmbiguousEmbyServerError. */
  resolveEmbyServer(): Promise<{ id: string; name: string; url: string } | null>;
  verifyServerAdmin(apiKey: string, url: string): Promise<VerifyAdminResult>;
  authenticate(url: string, username: string, password: string): Promise<AuthenticateResult | null>;
  createOwnerUser(username: string): Promise<{ id: string }>;
  insertServer(input: {
    name: string;
    url: string;
    token: string;
  }): Promise<{ id: string; name: string; url: string }>;
  updateServerToken(serverId: string, token: string): Promise<void>;
  linkEmbyAccount(input: { userId: string; accountId: string; accessToken: string }): Promise<void>;
  createSession(userId: string): Promise<{ token: string } | null>;
  deleteServer(serverId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  logError(message: string, context?: Record<string, unknown>): void;
}

const FIXED_URL_REJECTED_MESSAGE = 'The server URL is invalid or not permitted.';
const FIXED_SERVER_UNREACHABLE_MESSAGE = 'Could not reach the Emby server.';

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
  const state = await ports.getClaimState();

  if (state === 'owned') {
    throw new EmbySetupError(
      'INSTANCE_OWNED',
      403,
      'This Tracearr instance already has an owner. Only the owner can log in.'
    );
  }

  let canonicalUrl: string;
  let existingServer: { id: string; name: string; url: string } | null = null;

  if (state === 'ownerless-with-data') {
    ports.logError(
      `${OWNERLESS_INSTANCE_LOG_MARKER}: refused /emby/setup - instance holds data but has no owner`
    );
    // Unconditional in this state (design §3, item 1): a disabled claim code
    // is normally a no-op (see the centralized hook in auth.ts), but here the
    // absence of ANY configured code is itself the refusal - the instance
    // cannot be claimed from the network until the operator sets CLAIM_CODE
    // and restarts, or recovers through the CLI.
    if (!ports.isClaimCodeConfigured()) {
      throw new EmbySetupError('INSTANCE_RECOVERY', 403, OWNERLESS_INSTANCE_RECOVERY_MESSAGE);
    }
    let resolved: { id: string; name: string; url: string } | null;
    try {
      resolved = await ports.resolveEmbyServer();
    } catch {
      // Ambiguous resolution also refuses in this state (design §3) - no
      // partial-trust fallback to "pick one and continue".
      resolved = null;
    }
    if (!resolved) {
      throw new EmbySetupError('INSTANCE_RECOVERY', 403, OWNERLESS_INSTANCE_RECOVERY_MESSAGE);
    }
    existingServer = resolved;
    canonicalUrl = resolved.url;
  } else {
    try {
      canonicalUrl = canonicalizeSetupUrl(input.serverUrl);
    } catch {
      throw new EmbySetupError('URL_REJECTED', 400, FIXED_URL_REJECTED_MESSAGE);
    }
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

    let serverResult: { id: string; name: string; url: string };
    if (existingServer) {
      // Adopt, never duplicate: update the token only after it verified
      // above, and never touch the row's URL or name (design §6.3).
      await ports.updateServerToken(existingServer.id, input.apiKey);
      serverResult = existingServer;
    } else {
      const serverName = input.serverName?.trim() || 'Emby';
      const inserted = await ports.insertServer({
        name: serverName,
        url: canonicalUrl,
        token: input.apiKey,
      });
      insertedServerId = inserted.id;
      serverResult = inserted;
    }

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

    // Compensation (design §7.3): reverse order, and never delete a row this
    // attempt merely adopted. Compensation failures never mask the original
    // error - they log a greppable recovery marker naming the CLI commands
    // and the request still surfaces as SETUP_FAILED below.
    if (insertedServerId) {
      await ports.deleteServer(insertedServerId).catch((cleanupErr: unknown) => {
        ports.logError(
          'INSTANCE REQUIRES MANUAL RECOVERY: failed to delete orphaned server row after a ' +
            'failed Emby setup. Recover with `pnpm --filter @tracearr/server cli list-users` ' +
            'and `cli promote-owner <username>`.',
          { err: cleanupErr }
        );
      });
    }
    if (createdUser) {
      await ports.deleteUser(createdUser.id).catch((cleanupErr: unknown) => {
        ports.logError(
          'INSTANCE REQUIRES MANUAL RECOVERY: failed to delete orphaned owner user after a ' +
            'failed Emby setup. Recover with `pnpm --filter @tracearr/server cli list-users` ' +
            'and `cli promote-owner <username>`.',
          { err: cleanupErr }
        );
      });
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

function buildRealPorts(ctx: SetupEndpointCtx): EmbySetupPorts {
  const budgetDeadline = Date.now() + SETUP_TOTAL_BUDGET_MS;
  const totalBudgetController = new AbortController();
  const budgetTimer = setTimeout(
    () => totalBudgetController.abort(),
    Math.max(0, budgetDeadline - Date.now())
  );
  budgetTimer.unref();

  const fetchImpl = asJsonFetcher({
    timeoutMs: SETUP_PROBE_TIMEOUT_MS,
    signal: totalBudgetController.signal,
    onUpstreamError: (detail) => {
      logger.error('Emby setup probe failed', detail);
    },
  });

  return {
    getClaimState: getInstanceClaimState,
    isClaimCodeConfigured: isClaimCodeEnabled,
    resolveEmbyServer: resolveConfiguredEmbyServerRow,
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
    updateServerToken: async (serverId, token) => {
      await db
        .update(servers)
        .set({ token, updatedAt: new Date() })
        .where(eq(servers.id, serverId));
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
          if (!acquireSetupProbeSlot()) {
            throw new APIError('SERVICE_UNAVAILABLE', {
              message: 'Too many setup attempts are already in progress. Try again shortly.',
              body: { code: 'BUSY' },
            });
          }

          try {
            const result = await runEmbySetup(ctx.body, buildRealPorts(ctx));
            return ctx.json(result);
          } catch (err) {
            if (err instanceof EmbySetupError) {
              throw new APIError(httpStatusToApiStatus(err.httpStatus), {
                message: err.message,
                body: { code: err.code },
              });
            }
            logger.error('Unexpected error in /emby/setup', { err });
            throw new APIError('INTERNAL_SERVER_ERROR', {
              message: 'Failed to complete setup.',
              body: { code: 'SETUP_FAILED' },
            });
          } finally {
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

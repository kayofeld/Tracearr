import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { canLogin } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, servers, authAccounts } from '../db/schema.js';
import { isClaimCodeEnabled, validateClaimCode } from '../utils/claimCode.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('authGuards');

/**
 * The three-value instance state (SEC-01 fix,
 * docs/architecture/emby-native-setup.md §3). Replaces the two-value
 * "has an owner or not" model everywhere a claim path needs to distinguish
 * a genuinely fresh instance from one that is ownerless but still holds
 * data (a deleted owner, a partial restore, a failed setup compensation) -
 * claiming the latter is a takeover, not a bootstrap, because the previous
 * operator's servers/users/tokens are still sitting there for the new
 * "owner" to read via the owner-only backup export.
 */
export type InstanceClaimState = 'unclaimed' | 'ownerless-with-data' | 'owned';

/**
 * Operator-facing recovery message for the `ownerless-with-data` refusal.
 * Deliberately not uniform with the generic signup-closed message: this
 * state is already visible to any unauthenticated client via
 * `GET /setup/status` (needsSetup/hasServers/hasPasswordAuth), so naming the
 * recovery path here discloses nothing new while turning an otherwise-silent
 * dead end into an actionable instruction.
 */
export const OWNERLESS_INSTANCE_RECOVERY_MESSAGE =
  'This instance holds existing data but has no owner. Setup is disabled. ' +
  'Recover from the server console with ' +
  '`pnpm --filter @tracearr/server cli promote-owner <username>` and then `pnpm reset-password`.';

/** Greppable marker for the loud, persistent operator signal (design §3). */
export const OWNERLESS_INSTANCE_LOG_MARKER = 'OWNERLESS_INSTANCE_WITH_DATA';

function logOwnerlessRefusal(context: string): void {
  logger.error(`${OWNERLESS_INSTANCE_LOG_MARKER}: refused ${context}`);
}

/**
 * Derive the instance's claim state from four `limit(1)` selects issued in
 * parallel (design §3):
 *
 *   owner row?  any users row?  any auth_accounts row?  any servers row?  -> state
 *   yes         -                -                        -               -> owned
 *   no          no               no                       no              -> unclaimed
 *   no          otherwise any of the three present                        -> ownerless-with-data
 */
export async function getInstanceClaimState(): Promise<InstanceClaimState> {
  const [ownerRows, userRows, accountRows, serverRows] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
    db.select({ id: users.id }).from(users).limit(1),
    db.select({ id: authAccounts.id }).from(authAccounts).limit(1),
    db.select({ id: servers.id }).from(servers).limit(1),
  ]);

  if (ownerRows.length > 0) return 'owned';
  if (userRows.length === 0 && accountRows.length === 0 && serverRows.length === 0) {
    return 'unclaimed';
  }
  return 'ownerless-with-data';
}

/**
 * The single reusable claim-path gate (owner decision 6, design §3): refuses
 * whenever the instance is not `unclaimed`. Every path that can create the
 * owner - the better-auth `user.create` hook (which covers /sign-up/email,
 * /sign-up/username, and OIDC first-signup, since all three create the user
 * through `internalAdapter.createUser`) and /emby/setup's own state check -
 * calls this, so an ownerless-but-populated instance can be claimed from the
 * network by NONE of them; only the console (`cli promote-owner` +
 * `reset-password`) can recover it. `owned` keeps today's message; a second,
 * more specific message is used for `ownerless-with-data` because that
 * state is already disclosed by `GET /setup/status` (see the constant's own
 * comment).
 */
export async function assertSignupAllowed(): Promise<void> {
  const state = await getInstanceClaimState();
  if (state === 'owned') {
    throw new APIError('FORBIDDEN', {
      message: 'This Tracearr instance already has an owner. Only the owner can log in.',
    });
  }
  if (state === 'ownerless-with-data') {
    logOwnerlessRefusal('local/OIDC signup');
    throw new APIError('FORBIDDEN', { message: OWNERLESS_INSTANCE_RECOVERY_MESSAGE });
  }
}

export function assertClaimCode(claimCode: string | undefined): void {
  if (!isClaimCodeEnabled()) return;
  if (!claimCode || !validateClaimCode(claimCode)) {
    throw new APIError('FORBIDDEN', {
      message: 'Claim code is required for first-time setup',
    });
  }
}

// /sign-in/oauth2 handles both first-time signup and returning login, so the
// claim-path gate and the claim code are only enforced while the instance is
// unclaimed. `owned` returns early (a normal login, not a signup attempt);
// `ownerless-with-data` refuses outright, same as assertSignupAllowed - the
// gate applies to every claim path (owner decision 6), not only local signup.
export async function assertOAuthSignupClaimCode(claimCode: string | undefined): Promise<void> {
  const state = await getInstanceClaimState();
  if (state === 'owned') return;
  if (state === 'ownerless-with-data') {
    logOwnerlessRefusal('OIDC signup');
    throw new APIError('FORBIDDEN', { message: OWNERLESS_INSTANCE_RECOVERY_MESSAGE });
  }
  assertClaimCode(claimCode);
}

export async function assertUserCanLogin(userId: string): Promise<void> {
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row || !canLogin(row.role)) {
    throw new APIError('FORBIDDEN', { message: 'Account is not active' });
  }
}

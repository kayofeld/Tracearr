import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import { canLogin } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { getOwnerUser } from '../services/userService.js';
import { isClaimCodeEnabled, validateClaimCode } from '../utils/claimCode.js';

export async function assertSignupAllowed(): Promise<void> {
  const owner = await getOwnerUser();
  if (owner) {
    throw new APIError('FORBIDDEN', {
      message: 'This Tracearr instance already has an owner. Only the owner can log in.',
    });
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

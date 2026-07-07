import { describe, it, expect } from 'vitest';
import {
  mergeUsersBodySchema,
  mergeUserParamSchema,
  splitServerUserParamSchema,
  MERGE_SAME_SERVER_CONFIRMATION_REQUIRED,
} from '../index.js';

describe('merge schemas', () => {
  it('accepts a valid merge body and defaults confirmSameServerCombine to false', () => {
    const parsed = mergeUsersBodySchema.parse({
      targetUserId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
    });
    expect(parsed.confirmSameServerCombine).toBe(false);
  });

  it('accepts an explicit confirmSameServerCombine flag', () => {
    const parsed = mergeUsersBodySchema.parse({
      targetUserId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
      confirmSameServerCombine: true,
    });
    expect(parsed.confirmSameServerCombine).toBe(true);
  });

  it('rejects a non-uuid targetUserId', () => {
    expect(() => mergeUsersBodySchema.parse({ targetUserId: 'not-a-uuid' })).toThrow();
  });

  it('rejects non-uuid params', () => {
    expect(() => mergeUserParamSchema.parse({ id: '123' })).toThrow();
    expect(() => splitServerUserParamSchema.parse({ id: '123' })).toThrow();
  });

  it('exposes the same-server sentinel used by the API and web client', () => {
    expect(MERGE_SAME_SERVER_CONFIRMATION_REQUIRED).toBe(
      'same_server_combine_requires_confirmation'
    );
  });
});

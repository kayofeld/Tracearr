import { describe, it, expect } from 'vitest';
import {
  isUniqueViolationOn,
  USERS_SINGLE_OWNER_CONSTRAINT,
  SERVERS_SINGLE_EMBY_CONSTRAINT,
} from '../dbErrors.js';

describe('isUniqueViolationOn', () => {
  it('matches when the driver error message names the constraint', () => {
    const err = new Error('duplicate key value violates unique constraint "users_single_owner"');
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(true);
  });

  it('matches the servers_single_emby constraint the same way', () => {
    const err = new Error('duplicate key value violates unique constraint "servers_single_emby"');
    expect(isUniqueViolationOn(err, SERVERS_SINGLE_EMBY_CONSTRAINT)).toBe(true);
  });

  it('does not match an unrelated constraint violation', () => {
    const err = new Error('duplicate key value violates unique constraint "users_email_unique"');
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });

  it('does not match a non-Error value', () => {
    expect(isUniqueViolationOn('users_single_owner', USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn(null, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn(undefined, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });
});

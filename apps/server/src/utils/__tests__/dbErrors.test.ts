import { describe, it, expect } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  isUniqueViolationOn,
  USERS_SINGLE_OWNER_CONSTRAINT,
  SERVERS_SINGLE_EMBY_CONSTRAINT,
} from '../dbErrors.js';

/**
 * A minimal stand-in for node-postgres's `DatabaseError`: real production
 * code never constructs this class directly (pg's wire parser does), but the
 * shape - a plain object carrying `.code` and `.constraint` - is exactly what
 * pg-protocol's parser.js assigns onto the thrown error (`message.code =
 * fields.C`, `message.constraint = fields.n`), so this fixture matches the
 * real wire contract precisely without needing a live Postgres connection.
 */
function makePgUniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  const err = new Error(
    `duplicate key value violates unique constraint "${constraint}"`
  ) as Error & { code: string; constraint: string };
  err.code = '23505';
  err.constraint = constraint;
  return err;
}

/**
 * The REAL wrapped shape drizzle-orm 0.45's node-postgres driver produces:
 * `DrizzleQueryError`'s own `.message` is `Failed query: <sql>\nparams: ...`
 * (drizzle-orm/errors.js) - it never contains the constraint name - and the
 * pg `DatabaseError` (carrying `.code`/`.constraint`) lives at `.cause`. The
 * pre-fix test suite built a bare `Error` with the constraint name IN the
 * message, a shape drizzle never actually produces; every case below drives
 * the real `DrizzleQueryError` wrapper instead.
 */
function makeWrappedUniqueViolation(constraint: string): DrizzleQueryError {
  const cause = makePgUniqueViolation(constraint);
  return new DrizzleQueryError('insert into "users" ...', [], cause);
}

describe('isUniqueViolationOn', () => {
  it('matches the real DrizzleQueryError-wrapped shape (constraint in .cause, not .message)', () => {
    const err = makeWrappedUniqueViolation(USERS_SINGLE_OWNER_CONSTRAINT);

    // Pins the regression this fix guards: the wrapper's own message never
    // names the constraint, so any correct implementation MUST look at
    // `.cause`, not `.message`, to find it.
    expect(err.message).not.toContain(USERS_SINGLE_OWNER_CONSTRAINT);
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(true);
  });

  it('matches the servers_single_emby constraint the same way', () => {
    const err = makeWrappedUniqueViolation(SERVERS_SINGLE_EMBY_CONSTRAINT);
    expect(isUniqueViolationOn(err, SERVERS_SINGLE_EMBY_CONSTRAINT)).toBe(true);
  });

  it('does not match when the wrapped violation names a different constraint', () => {
    const err = makeWrappedUniqueViolation('users_email_unique');
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });

  it('does not match a unique_violation on an unrelated table/constraint even when the SQL text mentions the target table', () => {
    // A single insert site can violate more than one unique index - this
    // proves the match is keyed on the actual `.constraint` field, not on
    // any text in the query/message.
    const cause = makePgUniqueViolation('servers_url_unique');
    const err = new DrizzleQueryError(
      `insert into "servers" ("url") values ($1) -- ${SERVERS_SINGLE_EMBY_CONSTRAINT}`,
      ['http://emby.local'],
      cause
    );
    expect(isUniqueViolationOn(err, SERVERS_SINGLE_EMBY_CONSTRAINT)).toBe(false);
  });

  it('does not match a non-unique-violation pg error code wrapped the same way', () => {
    const cause = makePgUniqueViolation(USERS_SINGLE_OWNER_CONSTRAINT);
    cause.code = '23503'; // foreign_key_violation
    const err = new DrizzleQueryError('insert into "users" ...', [], cause);
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });

  it('walks more than one level of wrapping if present', () => {
    const pgErr = makePgUniqueViolation(USERS_SINGLE_OWNER_CONSTRAINT);
    const wrapped = new DrizzleQueryError('insert into "users" ...', [], pgErr);
    const doubleWrapped = new Error('adapter failure', { cause: wrapped });
    expect(isUniqueViolationOn(doubleWrapped, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(true);
  });

  it('does not match an unrelated bare Error (no .cause chain carrying a pg error)', () => {
    const err = new Error(`duplicate key value violates unique constraint "users_single_owner"`);
    // No `.cause`/`.code` at all - the constraint name only appears in
    // `.message`, which the fixed implementation deliberately ignores.
    expect(isUniqueViolationOn(err, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });

  it('does not match a non-Error value', () => {
    expect(isUniqueViolationOn('users_single_owner', USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn(null, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
    expect(isUniqueViolationOn(undefined, USERS_SINGLE_OWNER_CONSTRAINT)).toBe(false);
  });
});

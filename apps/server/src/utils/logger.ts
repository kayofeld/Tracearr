/**
 * Simple logger utility for services.
 *
 * Provides a consistent logging interface that can be enhanced later
 * with structured logging, log levels, or integration with external
 * logging services.
 *
 * IMP-12 fix: every log call's `context` is redacted before it reaches
 * `console.*`. The immediate trigger is CR-9/IMP-06 (logging the real cause
 * of a `SETUP_FAILED` error): `DrizzleQueryError` (drizzle-orm/errors.js)
 * carries the failed query's bound `params` array, and a setup/server-insert
 * failure's params include the Emby API key or password positionally - so
 * logging a raw driver error naively puts a secret in the log. Fixing that
 * the naive way (just `logger.error(message, { err })`) would do exactly
 * that; this redaction has to land first.
 *
 * NEW-01 fix: the Error-shape branch above rebuilds a safe message from the
 * query alone, but that protection is bypassed if a call site logs the raw
 * STRING message instead of the error object (e.g. `{ cause: err.message }`).
 * `redactValue` now strips the same `params: [...]` tail from every string
 * value it sees, not only from inside an `Error` instance, so this class of
 * leak cannot be reintroduced by a future call site either.
 */

/** Key names (case-insensitive) whose VALUE is replaced with a fixed marker, wherever found. */
const SENSITIVE_KEYS = new Set([
  'token',
  'apikey',
  'api_key',
  'password',
  'pw',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'authorization',
  'x-emby-token',
  'x-emby-authorization',
  'x-plex-token',
  'cookie',
  'set-cookie',
]);

/** Key names (case-insensitive) DROPPED entirely, wherever found - never even a redacted marker. */
const DROPPED_KEYS = new Set([
  // DrizzleQueryError's bound query parameters (drizzle-orm/errors.js) -
  // positional, so a sensitive value here is never caught by SENSITIVE_KEYS
  // (there is no key name to match against at all).
  'params',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

// NEW-01: `DrizzleQueryError`'s message text is built as `Failed query:
// <sql>\nparams: <params>` (drizzle-orm/errors.js: `` `params: ${params}` ``,
// which stringifies the bound params array as a plain comma-joined list, NOT
// bracketed JSON - so the tail has no reliable closing delimiter to anchor
// on; everything from `params:` to the end of the string is the bound-value
// dump and is dropped). The Error-branch below already rebuilds the message
// from the query alone (see the `isDrizzleQueryErrorShape` handling), but a
// caller can still hand a BARE STRING containing that same tail to a log
// context (e.g. `{ cause: err.message }` instead of `{ err }`) and bypass the
// Error-shape rebuild entirely, since a plain string used to pass through
// this function untouched. Stripping the tail here, for every string value
// regardless of key or nesting, closes that off at the source rather than
// relying on every call site remembering to pass the error object.
const PARAMS_TAIL_PATTERN = /\r?\n?params:\s*[\s\S]*$/i;

function stripParamsTail(value: string): string {
  return value.replace(PARAMS_TAIL_PATTERN, '');
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null) return value;
  if (typeof value === 'string') return stripParamsTail(value);
  if (typeof value !== 'object') return value;
  if (depth > MAX_DEPTH) return '[MAX_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  if (value instanceof Error) {
    // `DrizzleQueryError`'s OWN `.message` is built as
    // `Failed query: <sql>\nparams: <params>` (drizzle-orm/errors.js) - the
    // bound params are baked into the message text itself, not only into the
    // separate `.params` property dropped above. Duck-type-detect that exact
    // shape (own `query` string + `params` property) and rebuild a safe
    // message from the query alone; every other Error's message is
    // untouched.
    const asDrizzleShape = value as unknown as { query?: unknown; params?: unknown };
    const isDrizzleQueryErrorShape =
      typeof asDrizzleShape.query === 'string' && 'params' in asDrizzleShape;
    const out: Record<string, unknown> = {
      name: value.name,
      message: isDrizzleQueryErrorShape ? `Failed query: ${asDrizzleShape.query}` : value.message,
    };
    for (const key of Object.keys(value)) {
      const lower = key.toLowerCase();
      if (DROPPED_KEYS.has(lower)) continue;
      out[key] = SENSITIVE_KEYS.has(lower)
        ? REDACTED
        : redactValue((value as unknown as Record<string, unknown>)[key], depth + 1, seen);
    }
    // `cause` set via `new Error(msg, { cause })` is non-enumerable per the
    // Error Cause spec, so the Object.keys loop above can miss it even
    // though DrizzleQueryError's own `this.cause = cause` assignment (an
    // enumerable own property) is already covered by that loop.
    if (value.cause !== undefined && !('cause' in out)) {
      out.cause = redactValue(value.cause, depth + 1, seen);
    }
    return out;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (DROPPED_KEYS.has(lower)) continue;
    result[key] = SENSITIVE_KEYS.has(lower) ? REDACTED : redactValue(val, depth + 1, seen);
  }
  return result;
}

/** Redacts a log `context` object: drops `params` keys, masks secret-shaped keys, recursively. */
export function redactLogContext(
  context: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!context) return context;
  return redactValue(context, 0, new WeakSet()) as Record<string, unknown>;
}

export interface Logger {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

/**
 * Create a logger instance with optional namespace prefix.
 */
export function createLogger(namespace?: string): Logger {
  const prefix = namespace ? `[${namespace}] ` : '';

  return {
    debug: (message: string, context?: Record<string, unknown>) => {
      if (process.env.LOG_LEVEL === 'debug') {
        console.debug(prefix + message, redactLogContext(context) ?? '');
      }
    },
    info: (message: string, context?: Record<string, unknown>) => {
      console.info(prefix + message, redactLogContext(context) ?? '');
    },
    warn: (message: string, context?: Record<string, unknown>) => {
      console.warn(prefix + message, redactLogContext(context) ?? '');
    },
    error: (message: string, context?: Record<string, unknown>) => {
      console.error(prefix + message, redactLogContext(context) ?? '');
    },
  };
}

// Default logger for the automations engine
export const automationsLogger = createLogger('automations');

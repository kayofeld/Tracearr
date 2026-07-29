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

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
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

// Default logger for rules engine
export const rulesLogger = createLogger('rules');

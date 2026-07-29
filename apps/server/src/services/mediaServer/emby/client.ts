/**
 * Emby Media Server Client
 *
 * Implements IMediaServerClient for Emby servers.
 * Extends BaseMediaServerClient with Emby-specific authentication and activity log handling.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import { fetchJson, HttpClientError } from '../../../utils/http.js';
import { EMBY_LOGIN_FAILURE_REASONS, type EmbyLoginFailureReason } from '@tracearr/shared';
import {
  BaseMediaServerClient,
  type JellyfinEmbyActivityEntry,
  type JellyfinEmbyAuthResult,
  type JellyfinEmbyItemResult,
  type MediaServerParsers,
} from '../shared/baseMediaServerClient.js';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseActivityLogResponse,
  parseAuthResponse,
  parseItemsResponse,
  parseLibraryItemsResponse,
  parseUser,
} from './parser.js';

// Re-export types with platform-specific aliases for backward compatibility
export type EmbyActivityEntry = JellyfinEmbyActivityEntry;
export type EmbyAuthResult = JellyfinEmbyAuthResult;
export type EmbyItemResult = JellyfinEmbyItemResult;

/**
 * Emby Media Server client implementation
 *
 * @example
 * const client = new EmbyClient({ url: 'http://emby.local:8096', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class EmbyClient extends BaseMediaServerClient {
  public readonly serverType = 'emby' as const;

  protected readonly parsers: MediaServerParsers = {
    parseSessionsResponse,
    parseUsersResponse,
    parseLibrariesResponse,
    parseWatchHistoryResponse,
    parseActivityLogResponse,
    parseItemsResponse,
    parseLibraryItemsResponse,
    parseUser,
    parseAuthResponse,
  };

  // ==========================================================================
  // Emby-Specific: Activity Log (PascalCase query params)
  // ==========================================================================

  /**
   * Get activity log entries (requires admin)
   *
   * Note: Emby uses PascalCase query parameters (Limit, MinDate, HasUserId)
   */
  async getActivityLog(options?: {
    minDate?: Date;
    limit?: number;
    hasUserId?: boolean;
  }): Promise<EmbyActivityEntry[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.append('Limit', String(options.limit));
    if (options?.minDate) params.append('MinDate', options.minDate.toISOString());
    if (options?.hasUserId !== undefined) params.append('HasUserId', String(options.hasUserId));

    const data = await fetchJson<unknown>(`${this.baseUrl}/System/ActivityLog/Entries?${params}`, {
      headers: this.buildHeaders(),
      service: 'emby',
    });

    return parseActivityLogResponse(data);
  }

  // ==========================================================================
  // Static Methods - Authentication (Emby-specific)
  // ==========================================================================

  /**
   * Authenticate with username/password
   * Note: Emby takes the plaintext password in the `Pw` field (same as Jellyfin).
   * Verified live against Emby 4.9.5: `Pw` returns 200 + a token, while sending
   * the password in a `Password` field returns 401.
   */
  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<EmbyAuthResult | null> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = BaseMediaServerClient.buildStaticAuthHeader();

    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
          'X-Emby-Authorization': authHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          Username: username,
          Pw: password, // plaintext password field Emby expects (NOT `Password`)
        }),
        service: 'emby',
        timeout: 10000, // bound the login round-trip (parity with verifyServerAdmin)
      });

      return parseAuthResponse(data);
    } catch (error) {
      if (error instanceof Error && error.message.includes('401')) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Error types for server admin verification
   */
  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  /**
   * Verify if API key has admin access to an Emby server
   *
   * Handles two token types:
   * 1. User tokens (from AuthenticateByName) - verified via /Users/Me
   * 2. API keys (created in Emby admin) - verified via /Auth/Keys (requires admin)
   *
   * @returns { success: true } if admin access verified
   * @returns { success: false, code, message } if verification failed
   */
  static async verifyServerAdmin(
    apiKey: string,
    serverUrl: string
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');

    const headers = {
      'X-Emby-Authorization': BaseMediaServerClient.buildStaticAuthHeader(apiKey),
      Accept: 'application/json',
    };

    // Verify basic (unauthenticated) connectivity so a network problem is distinct from auth.
    try {
      await fetchJson<unknown>(`${url}/System/Info/Public`, {
        headers: { Accept: 'application/json' },
        service: 'emby',
        timeout: 10000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Emby server at ${url}. ${message}`,
      };
    }

    // Try /Users/Me first (works for user tokens from AuthenticateByName).
    try {
      const data = await fetchJson<Record<string, unknown>>(`${url}/Users/Me`, {
        headers,
        service: 'emby',
        timeout: 10000,
      });

      const user = parseUser(data);
      if (user.isAdmin) {
        return { success: true };
      }
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.NOT_ADMIN,
        message: 'This Emby account is not an administrator.',
      };
    } catch (error) {
      // 401 means the key was rejected outright. API keys (no user context) get a
      // non-401 error here — observed: 500 on Emby 4.9.5 (Jellyfin returns 400) —
      // which is expected; fall through to /Auth/Keys.
      if (error instanceof HttpClientError && error.statusCode === 401) {
        return {
          success: false,
          code: EmbyClient.AdminVerifyError.INVALID_KEY,
          message: 'Emby rejected this API key (it may be invalid or expired).',
        };
      }
    }

    // Try /Auth/Keys, which only admin-level API keys can read.
    try {
      await fetchJson<unknown>(`${url}/Auth/Keys`, {
        headers,
        service: 'emby',
        timeout: 10000,
      });
      return { success: true };
    } catch (error) {
      if (error instanceof HttpClientError) {
        if (error.statusCode === 401) {
          return {
            success: false,
            code: EmbyClient.AdminVerifyError.INVALID_KEY,
            message: 'Emby rejected this API key (it may be invalid or expired).',
          };
        }
        if (error.statusCode === 403) {
          return {
            success: false,
            code: EmbyClient.AdminVerifyError.NOT_ADMIN,
            message: 'This API key does not have administrator access on this Emby server.',
          };
        }
      }
      const message = error instanceof Error ? error.message : 'Unable to verify admin access';
      return {
        success: false,
        code: EmbyClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Could not verify admin access on Emby server at ${url}. ${message}`,
      };
    }
  }

  /**
   * Best-effort diagnosis of WHY a username/password login just failed,
   * using the server's admin API key (never the submitted password) to
   * inspect the account. Used by embyPlugin.ts to turn today's flat
   * "Invalid Emby username or password" into a specific reason.
   *
   * Distinguishes:
   * - `user_not_found`     - no user with this name exists on the server.
   * - `account_disabled`   - the account exists and Policy.IsDisabled is true
   *                          (an administrator disabled it).
   * - `account_locked_out` - the account exists, is not disabled, and Emby's
   *                          own failed-login lockout has tripped (see below).
   * - `wrong_password`     - the account exists, is not disabled, and no
   *                          lockout was observed - the password itself was
   *                          rejected.
   *
   * `account_locked_out` relies on Policy.InvalidLoginAttemptCount and
   * Policy.LoginAttemptsBeforeLockout, which Emby only populates when its
   * own lockout-after-failed-attempts feature is enabled for the account
   * (LoginAttemptsBeforeLockout > 0). Neither field is guaranteed present on
   * every Emby version/config - when either is missing or not a number, this
   * deliberately does NOT claim a lockout it cannot verify and falls through
   * to `wrong_password` instead (still true: account exists, not disabled,
   * credentials rejected).
   *
   * Throws on anything it cannot use to make a determination (network
   * error, timeout, invalid/insufficient admin key, unparseable response) -
   * the caller (embyPlugin.ts) treats any throw as "diagnosis unavailable"
   * and falls back to the generic message, never surfacing this failure as
   * more informative than it actually is.
   */
  static async diagnoseLoginFailure(
    serverUrl: string,
    adminApiKey: string,
    username: string,
    timeoutMs: number
  ): Promise<EmbyLoginFailureReason> {
    const url = serverUrl.replace(/\/$/, '');
    const headers = {
      'X-Emby-Authorization': BaseMediaServerClient.buildStaticAuthHeader(adminApiKey),
      Accept: 'application/json',
    };

    const data = await fetchJson<unknown>(`${url}/Users`, {
      headers,
      service: 'emby',
      timeout: timeoutMs,
    });
    if (!Array.isArray(data)) {
      throw new Error('Unexpected /Users response shape (not an array)');
    }

    const normalizedUsername = username.toLowerCase();
    const match = data.find((entry): entry is Record<string, unknown> => {
      if (!entry || typeof entry !== 'object') return false;
      const name = (entry as Record<string, unknown>).Name;
      return typeof name === 'string' && name.toLowerCase() === normalizedUsername;
    });
    if (!match) return EMBY_LOGIN_FAILURE_REASONS.USER_NOT_FOUND;

    const policy =
      match.Policy && typeof match.Policy === 'object'
        ? (match.Policy as Record<string, unknown>)
        : {};
    if (policy.IsDisabled === true) return EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_DISABLED;

    const lockoutThreshold = policy.LoginAttemptsBeforeLockout;
    const invalidAttempts = policy.InvalidLoginAttemptCount;
    if (
      typeof lockoutThreshold === 'number' &&
      lockoutThreshold > 0 &&
      typeof invalidAttempts === 'number' &&
      invalidAttempts >= lockoutThreshold
    ) {
      return EMBY_LOGIN_FAILURE_REASONS.ACCOUNT_LOCKED_OUT;
    }

    return EMBY_LOGIN_FAILURE_REASONS.WRONG_PASSWORD;
  }
}

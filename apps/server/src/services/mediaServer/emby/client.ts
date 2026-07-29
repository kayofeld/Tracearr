/**
 * Emby Media Server Client
 *
 * Implements IMediaServerClient for Emby servers.
 * Extends BaseMediaServerClient with Emby-specific authentication and activity log handling.
 *
 * Based on Emby OpenAPI specification v4.1.1.0
 */

import { fetchJson, HttpClientError, type HttpRequestOptions } from '../../../utils/http.js';
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
 * The shape `authenticate`/`verifyServerAdmin` call fetchJson through.
 * Defaults to the plain `fetchJson` (today's behavior, unchanged for
 * /emby/login and POST /servers - design §8.1). The setup plugin
 * (embySetupPlugin.ts) passes `safeProbeJson` wrapped to this shape instead,
 * for the hardened pre-auth path where the URL comes from the client
 * (SEC-03, docs/architecture/emby-native-setup.md §8).
 */
export type EmbyJsonFetcher = <T>(url: string, options?: HttpRequestOptions) => Promise<T>;

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
    password: string,
    fetchImpl: EmbyJsonFetcher = fetchJson
  ): Promise<EmbyAuthResult | null> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = BaseMediaServerClient.buildStaticAuthHeader();

    try {
      const data = await fetchImpl<Record<string, unknown>>(`${url}/Users/AuthenticateByName`, {
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
      // CR-4 fix: discriminate on the typed status code, not a message
      // substring. The pre-fix check (`error.message.includes('401')`)
      // happened to work for the default `fetchJson` path (its
      // `HttpClientError`'s default message literally contains "401"), but
      // `safeProbeJson` (the setup plugin's hardened fetcher, SEC-03c) throws
      // a fixed, generic message that never contains a status code at all -
      // so a wrong password on that path fell through to `throw error` and
      // surfaced as an uncaught 500, rather than the null this function's
      // contract promises for bad credentials. `HttpClientError.statusCode`
      // is populated by both fetchers now (utils/http.ts, utils/safeProbe.ts).
      // (L6, security review: also guards against a wrapped error whose
      // message merely CONTAINS "401".)
      if (error instanceof HttpClientError && error.statusCode === 401) {
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
    serverUrl: string,
    fetchImpl: EmbyJsonFetcher = fetchJson
  ): Promise<{ success: true } | { success: false; code: string; message: string }> {
    const url = serverUrl.replace(/\/$/, '');

    const headers = {
      'X-Emby-Authorization': BaseMediaServerClient.buildStaticAuthHeader(apiKey),
      Accept: 'application/json',
    };

    // Verify basic (unauthenticated) connectivity so a network problem is distinct from auth.
    try {
      await fetchImpl<unknown>(`${url}/System/Info/Public`, {
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
      const data = await fetchImpl<Record<string, unknown>>(`${url}/Users/Me`, {
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
      await fetchImpl<unknown>(`${url}/Auth/Keys`, {
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
   * Fetches the SINGLE Emby account already linked to the Tracearr owner, by
   * its Emby account id - never a name search or a list scan across
   * `/Users`. Used by embyPlugin.ts's diagnoseEmbyLoginFailure to read the
   * account's LIVE disabled state after it has already confirmed locally
   * (via the server_users sync cache) that the submitted username
   * corresponds to this linked account (security review F1) - this method
   * itself never sees or compares a username.
   *
   * account_locked_out is no longer a possible outcome anywhere in this path
   * (security review F2, owner decision): this endpoint forwards the
   * submitted credentials to Emby's own AuthenticateByName, so reporting a
   * lockout here would confirm to an anonymous caller that their
   * credential-stuffing tripped Emby's own lockout. A locked-out account now
   * reads as "not disabled" and falls back to wrong_password in the caller
   * (still true: exists, not disabled, credentials rejected).
   *
   * Throws on anything it cannot use to make a determination (network
   * error, timeout, 404 if the linked account was since deleted on Emby,
   * invalid/insufficient admin key, unparseable response) - the caller
   * treats any throw as "diagnosis unavailable" and falls back to the
   * generic message.
   */
  static async getLinkedEmbyAccount(
    serverUrl: string,
    adminApiKey: string,
    accountId: string,
    timeoutMs: number
  ): Promise<{ isDisabled: boolean }> {
    const url = serverUrl.replace(/\/$/, '');
    const headers = {
      'X-Emby-Authorization': BaseMediaServerClient.buildStaticAuthHeader(adminApiKey),
      Accept: 'application/json',
    };

    const data = await fetchJson<unknown>(`${url}/Users/${encodeURIComponent(accountId)}`, {
      headers,
      service: 'emby',
      timeout: timeoutMs,
    });
    if (!data || typeof data !== 'object') {
      throw new Error('Unexpected /Users/{id} response shape');
    }

    const policy =
      (data as Record<string, unknown>).Policy &&
      typeof (data as Record<string, unknown>).Policy === 'object'
        ? ((data as Record<string, unknown>).Policy as Record<string, unknown>)
        : {};
    return { isDisabled: policy.IsDisabled === true };
  }
}

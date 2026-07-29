/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { updateSettingsSchema, type Settings, type WebhookFormat } from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, sessions } from '../db/schema.js';
import { geoipService } from '../services/geoip.js';
import { notificationManager } from '../services/notifications/index.js';
import { getAllSettings, getSettings, setSettings } from '../services/settings.js';
import { invalidateOmbiCaches } from '../jobs/ombiSyncQueue.js';
import { invalidateSeerrCaches } from '../jobs/seerrSyncQueue.js';
import { assertSafeProbeUrl, SsrfBlockedError } from '../utils/ssrf.js';

// Re-export service getters so existing import paths still work
export {
  getPollerSettings,
  getGeoIPSettings,
  getNetworkSettings,
  getNotificationSettings,
  getBackupScheduleSettings,
  type NotificationSettings,
} from '../services/settings.js';

// API token format: trr_pub_<32 random bytes as base64url>
const API_TOKEN_PREFIX = 'trr_pub_';

function generateApiToken(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${API_TOKEN_PREFIX}${randomPart}`;
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /settings - Get application settings
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can view settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }

    return getAllSettings();
  });

  /**
   * PATCH /settings - Update application settings
   */
  app.patch('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = updateSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Only owners can update settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update settings');
    }

    // Build update object from provided fields
    const updates: Partial<Settings> = {};
    // dockerRedeployWebhookUrl is intentionally NOT part of `Settings` (it is
    // write-only, never echoed back - see services/settings.ts
    // INTERNAL_DEFAULTS) so it is collected separately and validated before
    // being merged into `updates` below.
    let dockerRedeployWebhookUrl: string | null | undefined;

    for (const [key, value] of Object.entries(body.data)) {
      if (value !== undefined) {
        if (key === 'externalUrl' && typeof value === 'string') {
          // Strip trailing slash for consistency
          updates.externalUrl = value.replace(/\/+$/, '') || null;
        } else if (key === 'dockerRedeployWebhookUrl') {
          dockerRedeployWebhookUrl = value as string | null;
        } else {
          (updates as Record<string, unknown>)[key] = value;
        }
      }
    }

    // SSRF check at save time (contract: validate on save AND before every
    // outbound call - see routes/version.ts). Loopback/RFC1918 stay allowed,
    // same as the Ombi/Seerr connectors - Portainer normally runs on the same
    // host or LAN.
    if (dockerRedeployWebhookUrl !== undefined) {
      if (dockerRedeployWebhookUrl !== null) {
        try {
          assertSafeProbeUrl(dockerRedeployWebhookUrl);
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            // Do NOT relay err.message here: for a malformed URL it embeds the
            // raw input verbatim (`Malformed URL: ${rawUrl}`), and the webhook
            // UUID *is* the secret (brief §2) - echoing it back would leak it
            // into the response body. Generic message only, unlike the
            // Ombi/Seerr test-connection routes which can safely relay
            // SsrfBlockedError.message (their URL carries no embedded secret).
            return reply.badRequest(
              'Invalid or disallowed webhook URL. Must be a valid http(s) URL and not target a link-local address.'
            );
          }
          throw err;
        }
      }
      (updates as Record<string, unknown>).dockerRedeployWebhookUrl = dockerRedeployWebhookUrl;
    }

    await setSettings(updates);

    // Ombi/Seerr connect/disconnect (OMB-4, and the identical SEERR-03 for
    // the Seerr connector): /library/stale and /stats/requesters cache their
    // requester attribution for up to 1h (CACHE_TTL.LIBRARY_STALE /
    // OMBI_REQUESTER_STATS - the latter is the shared cross-source cache,
    // legacy name kept deliberately, contract §8). Clearing either
    // connector's url/apiKey (disconnect) must invalidate those caches
    // immediately - the contract requires requestedBy to be null once
    // unconfigured, not stale for up to an hour. Invalidate on any change to
    // either setting (covers connect too).
    if ('ombiUrl' in updates || 'ombiApiKey' in updates) {
      await invalidateOmbiCaches(app.redis);
    }
    if ('seerrUrl' in updates || 'seerrApiKey' in updates) {
      await invalidateSeerrCaches(app.redis);
    }

    // Return updated settings with masks
    return getAllSettings();
  });

  /**
   * POST /settings/test-webhook - Send a test notification to verify webhook configuration
   */
  app.post<{
    Body: {
      type: 'discord' | 'custom';
      url?: string;
      format?: WebhookFormat;
      ntfyTopic?: string;
      ntfyAuthToken?: string;
      pushoverUserKey?: string;
      pushoverApiToken?: string;
    };
  }>('/test-webhook', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can test webhooks
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can test webhooks');
    }

    const { type, url, format } = request.body;

    if (!type) {
      return reply.badRequest('Missing webhook type');
    }

    // Get current notification settings
    const currentSettings = await getSettings([
      'discordWebhookUrl',
      'customWebhookUrl',
      'webhookFormat',
      'ntfyTopic',
      'ntfyAuthToken',
      'pushoverUserKey',
      'pushoverApiToken',
      'telegramBotToken',
      'telegramChatId',
    ]);

    let webhookUrl: string | null = null;
    let webhookFormat: WebhookFormat = 'json';
    let ntfyTopic: string | null = null;
    let ntfyAuthToken: string | null = null;
    let pushoverUserKey: string | null = null;
    let pushoverApiToken: string | null = null;
    let telegramBotToken: string | null = null;
    let telegramChatId: string | null = null;

    if (type === 'discord') {
      webhookUrl = url ?? currentSettings.discordWebhookUrl ?? null;
    } else {
      webhookUrl = url ?? currentSettings.customWebhookUrl ?? null;
      webhookFormat = format ?? currentSettings.webhookFormat ?? 'json';
      ntfyTopic = currentSettings.ntfyTopic ?? null;
      ntfyAuthToken = currentSettings.ntfyAuthToken ?? null;
      pushoverUserKey = currentSettings.pushoverUserKey ?? null;
      pushoverApiToken = currentSettings.pushoverApiToken ?? null;
      telegramBotToken = currentSettings.telegramBotToken ?? null;
      telegramChatId = currentSettings.telegramChatId ?? null;
    }

    if (webhookFormat === 'pushover') {
      if (!pushoverUserKey || !pushoverApiToken) {
        return reply.badRequest('Pushover requires User Key and API Token');
      }
    } else if (webhookFormat === 'telegram') {
      if (!telegramBotToken || !telegramChatId) {
        return reply.badRequest('Telegram requires a Bot Token and Chat ID');
      }
    } else if (!webhookUrl) {
      return reply.badRequest(`No ${type} webhook URL configured`);
    }

    // Build notification settings for testing
    const testSettings = {
      discordWebhookUrl: type === 'discord' ? webhookUrl : null,
      customWebhookUrl: type === 'custom' ? webhookUrl : null,
      webhookFormat,
      ntfyTopic,
      ntfyAuthToken,
      pushoverUserKey,
      pushoverApiToken,
      telegramBotToken,
      telegramChatId,
    };

    // Determine which agent to test based on type and format
    let agentName: string;
    if (type === 'discord') {
      agentName = 'discord';
    } else {
      // Custom webhook - determine agent based on format
      switch (webhookFormat) {
        case 'ntfy':
          agentName = 'ntfy';
          break;
        case 'apprise':
          agentName = 'apprise';
          break;
        case 'pushover':
          agentName = 'pushover';
          break;
        case 'gotify':
          agentName = 'gotify';
          break;
        case 'telegram':
          agentName = 'telegram';
          break;
        default:
          agentName = 'json-webhook';
      }
    }

    const result = await notificationManager.testAgent(agentName, testSettings);

    if (!result.success) {
      return reply.code(502).send({
        success: false,
        error: result.error ?? 'Webhook test failed',
      });
    }

    return { success: true };
  });

  /**
   * GET /settings/api-key - Get current API key
   * Returns the full API key (retrievable anytime like Sonarr/Radarr)
   */
  app.get('/api-key', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const [user] = await db
      .select({ apiToken: users.apiToken })
      .from(users)
      .where(eq(users.id, authUser.userId))
      .limit(1);

    return { token: user?.apiToken ?? null };
  });

  /**
   * POST /settings/api-key/regenerate - Generate or regenerate API key
   * Creates a new API key, invalidating any previous key
   */
  app.post('/api-key/regenerate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const newToken = generateApiToken();

    await db
      .update(users)
      .set({ apiToken: newToken, updatedAt: new Date() })
      .where(eq(users.id, authUser.userId));

    return { token: newToken };
  });

  /**
   * GET /settings/ip-warning - Check if IP configuration warning should be shown
   * Returns whether all users have the same IP or all have local/private IPs
   */
  app.get('/ip-warning', { preHandler: [app.authenticate] }, async (_request, _reply) => {
    // Get distinct IPs from recent sessions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const distinctIps = await db
      .selectDistinct({
        ipAddress: sessions.ipAddress,
      })
      .from(sessions)
      .where(sql`${sessions.startedAt} >= ${thirtyDaysAgo}`);

    // If no sessions, don't show warning
    if (distinctIps.length === 0) {
      return { showWarning: false, stateHash: 'no-sessions' };
    }

    // Check if all IPs are the same
    const uniqueIps = distinctIps
      .map((row) => row.ipAddress)
      .filter((ip): ip is string => ip !== null);
    const allSameIp = uniqueIps.length === 1;

    // Check if all IPs are private/local
    const allPrivate = uniqueIps.every((ip) => geoipService.isPrivateIP(ip));

    const showWarning = allSameIp || allPrivate;

    // Generate stateHash based on the situation
    let stateHash: string;
    if (allSameIp && allPrivate) {
      stateHash = 'single-private-ip';
    } else if (allSameIp) {
      stateHash = 'single-ip';
    } else if (allPrivate) {
      stateHash = 'all-private';
    } else {
      stateHash = 'normal';
    }

    return { showWarning, stateHash };
  });
};

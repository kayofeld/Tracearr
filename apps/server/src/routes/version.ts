/**
 * Version API Routes
 *
 * Provides version information and update status.
 */

import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type {
  VersionInfo,
  VersionUpdateCapability,
  VersionUpdateStartResponse,
  VersionUpdateStatus,
} from '@tracearr/shared';
import {
  getCurrentVersion,
  getCurrentTag,
  getCurrentCommit,
  getBuildDate,
  getCachedLatestVersion,
  isNewerVersion,
  isPrerelease,
  forceVersionCheck,
} from '../jobs/versionCheckQueue.js';
import { PROJECT_ROOT } from '../lib/paths.js';
import { getDockerRedeployWebhookUrl } from '../services/settings.js';
import { assertSafeProbeUrl, SsrfBlockedError } from '../utils/ssrf.js';

/** In-app self-update is opt-in and only for the bare-metal/systemd deployment. */
const SELF_UPDATE_ENABLED = process.env.TRACEARR_SELF_UPDATE === 'true';
const UPDATE_STATUS_FILE = resolve(PROJECT_ROOT, '.update-status.json');

/**
 * Bound for the outbound Portainer redeploy-webhook POST (design constraint:
 * a hanging Portainer must not pin the request). Server-side constant only -
 * never derived from client/setting input.
 */
const DOCKER_REDEPLOY_WEBHOOK_TIMEOUT_MS = 10_000;

/** Owner-facing caveats surfaced by GET /update/capability (design constraints). */
const DOCKER_NOTE_NOT_CONFIGURED =
  'Configure a Portainer stack redeploy webhook in Settings to enable in-app updates for this deployment.';
const DOCKER_NOTE_CONFIGURED =
  'Redeploying only changes the running version if your compose file tracks a moving tag (e.g. ":latest"). A pinned exact version tag (e.g. ":1.9.0") will redeploy unchanged.';

async function runningInDocker(): Promise<boolean> {
  return access('/.dockerenv').then(
    () => true,
    () => false
  );
}

/**
 * POST to the owner-configured Portainer redeploy webhook. The URL itself is
 * the secret (embedded webhook UUID) - callers must never log or return
 * `err.message` from a caught failure verbatim, since some failure modes
 * (SSRF rejection of a malformed URL) embed the raw URL.
 */
async function triggerDockerRedeployWebhook(webhookUrl: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOCKER_REDEPLOY_WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      signal: controller.signal,
      // Treat any redirect as a hard failure rather than letting undici
      // forward the request to an arbitrary target (SSRF bypass via
      // redirect - mirrors services/ombi.ts / services/seerr.ts).
      redirect: 'manual',
    });
    if (response.type === 'opaqueredirect') {
      throw new Error('Redeploy webhook returned a redirect');
    }
    if (!response.ok) {
      throw new Error(`Redeploy webhook responded with HTTP ${response.status}`);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Redeploy webhook timed out after ${DOCKER_REDEPLOY_WEBHOOK_TIMEOUT_MS}ms`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

export const versionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /version
   * Get current version info and update status
   * Public endpoint - no auth required (useful for health checks)
   */
  app.get<{
    Reply: VersionInfo;
  }>('/', async () => {
    const currentVersion = getCurrentVersion();
    const currentTag = getCurrentTag();
    const currentCommit = getCurrentCommit();
    const buildDate = getBuildDate();

    // Get cached latest version info
    const latestData = await getCachedLatestVersion();

    // Determine if update is available
    const updateAvailable = latestData ? isNewerVersion(latestData.version, currentVersion) : false;

    return {
      current: {
        version: currentVersion,
        tag: currentTag,
        commit: currentCommit,
        buildDate,
        isPrerelease: isPrerelease(currentVersion),
      },
      latest: latestData
        ? {
            version: latestData.version,
            tag: latestData.tag,
            releaseUrl: latestData.releaseUrl,
            publishedAt: latestData.publishedAt,
            isPrerelease: latestData.isPrerelease,
            releaseName: latestData.releaseName,
            releaseNotes: latestData.releaseNotes,
          }
        : null,
      updateAvailable,
      lastChecked: latestData?.checkedAt ?? null,
    };
  });

  /**
   * POST /version/check
   * Force an immediate version check (admin only)
   */
  app.post('/check', {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      // Require admin role
      if (request.user.role !== 'owner' && request.user.role !== 'admin') {
        return reply.forbidden('Admin access required');
      }

      await forceVersionCheck();

      return { message: 'Version check queued' };
    },
  });

  /**
   * GET /version/update/capability
   * Report whether the in-app update button can be used on this deployment.
   */
  app.get<{ Reply: VersionUpdateCapability }>(
    '/update/capability',
    { preHandler: [app.authenticate] },
    async (request) => {
      const isOwner = request.user.role === 'owner';
      const docker = await runningInDocker();

      let dockerRedeployConfigured = false;
      let dockerNote: string | null = null;
      if (docker) {
        // Never place the webhook URL itself on this response - only the
        // derived boolean (brief §2/§3: the URL is the auth secret).
        const webhookUrl = await getDockerRedeployWebhookUrl();
        dockerRedeployConfigured = Boolean(webhookUrl);
        dockerNote = dockerRedeployConfigured ? DOCKER_NOTE_CONFIGURED : DOCKER_NOTE_NOT_CONFIGURED;
      }

      return {
        // Bare metal: owner + self-update explicitly enabled (the updater
        // unit + sudoers must be set up on the host) + not Docker.
        // Docker: owner + a redeploy webhook is configured (SELF_UPDATE_ENABLED
        // is a bare-metal-only opt-in and irrelevant to the Docker path).
        available:
          isOwner && ((SELF_UPDATE_ENABLED && !docker) || (docker && dockerRedeployConfigured)),
        enabled: SELF_UPDATE_ENABLED,
        isDocker: docker,
        dockerRedeployConfigured,
        dockerNote,
      };
    }
  );

  /**
   * POST /version/update
   * Trigger an update (owner only, opt-in). Bare metal kicks off the
   * tracearr-update.service unit which rebuilds and restarts in its own
   * cgroup. Docker POSTs to the owner-configured Portainer stack redeploy
   * webhook instead (a container cannot rebuild itself).
   */
  app.post<{ Reply: VersionUpdateStartResponse }>(
    '/update',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (request.user.role !== 'owner') {
        return reply.forbidden('Only the owner can update the server.');
      }

      // Docker is checked first and independently of SELF_UPDATE_ENABLED: that
      // flag is the bare-metal-only opt-in (updater unit + sudoers on the
      // host) and has no bearing on whether a redeploy webhook is configured.
      if (await runningInDocker()) {
        const webhookUrl = await getDockerRedeployWebhookUrl();
        if (!webhookUrl) {
          return reply.badRequest(
            'Docker deployments update by pulling a new image, not this button. Configure a Portainer redeploy webhook in Settings to enable in-app updates.'
          );
        }

        // Re-validate before every outbound call (brief §5), even though the
        // setting was already validated on save (routes/settings.ts) - the
        // allowed-range policy could change between save and use.
        try {
          assertSafeProbeUrl(webhookUrl);
        } catch (err) {
          if (err instanceof SsrfBlockedError) {
            // Do NOT relay err.message or the URL: the webhook URL embeds the
            // secret (brief §2), and a malformed-URL SsrfBlockedError echoes
            // the raw input verbatim.
            request.log.warn('Configured Docker redeploy webhook URL failed the SSRF check');
            return reply.internalServerError(
              'The configured redeploy webhook URL is no longer valid. Re-save it in Settings.'
            );
          }
          throw err;
        }

        const latest = await getCachedLatestVersion();
        if (!latest || !isNewerVersion(latest.version, getCurrentVersion())) {
          return reply.badRequest('Already up to date.');
        }

        try {
          await triggerDockerRedeployWebhook(webhookUrl);
        } catch {
          // Never log/return the caught error's message: it can originate
          // from fetch/undici internals that may echo the request URL
          // (which embeds the webhook secret). Fixed, generic text only.
          request.log.error('Failed to trigger the Docker redeploy webhook');
          return reply.internalServerError(
            'Failed to trigger the redeploy webhook. Check that Portainer is reachable and the URL is correct.'
          );
        }

        return {
          started: true,
          target: latest.version,
          note: 'Redeploy triggered. This server may restart shortly and cannot report further progress from here - check Portainer for status.',
        };
      }

      if (!SELF_UPDATE_ENABLED) {
        return reply.badRequest(
          'In-app update is not enabled. Set TRACEARR_SELF_UPDATE=true and install the updater unit.'
        );
      }

      const latest = await getCachedLatestVersion();
      if (!latest || !isNewerVersion(latest.version, getCurrentVersion())) {
        return reply.badRequest('Already up to date.');
      }

      // Fire-and-forget: start the updater unit non-blocking so it survives this
      // process's own restart. No user input is passed to the command.
      try {
        const child = spawn(
          'sudo',
          ['systemctl', 'start', '--no-block', 'tracearr-update.service'],
          {
            stdio: 'ignore',
            detached: true,
          }
        );
        child.unref();
      } catch (err) {
        request.log.error({ err }, 'Failed to start updater unit');
        return reply.internalServerError('Failed to start the updater.');
      }

      return { started: true, target: latest.version };
    }
  );

  /**
   * GET /version/update/status
   * Read the updater's progress file (written by scripts/update.sh, bare
   * metal only). Docker never reads the file: firing the redeploy webhook
   * recreates this container, so the process that would poll it (and quite
   * possibly the file itself, depending on volume layout) may already be
   * gone - report a fixed 'unknown' state rather than faking progress we
   * cannot observe, so the UI is never left polling a file that can never
   * appear.
   */
  app.get<{ Reply: VersionUpdateStatus }>(
    '/update/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      if (request.user.role !== 'owner') {
        return reply.forbidden('Only the owner can view update status.');
      }

      if (await runningInDocker()) {
        return {
          state: 'unknown',
          message:
            'Docker deployments cannot report update progress from inside the container. Check Portainer for the stack status.',
          at: null,
        };
      }

      try {
        const raw = await readFile(UPDATE_STATUS_FILE, 'utf8');
        return JSON.parse(raw) as VersionUpdateStatus;
      } catch {
        return { state: 'idle', message: null, at: null };
      }
    }
  );
};

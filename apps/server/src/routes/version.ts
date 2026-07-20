/**
 * Version API Routes
 *
 * Provides version information and update status.
 */

import { spawn } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import type { VersionInfo } from '@tracearr/shared';
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

/** In-app self-update is opt-in and only for the bare-metal/systemd deployment. */
const SELF_UPDATE_ENABLED = process.env.TRACEARR_SELF_UPDATE === 'true';
const UPDATE_STATUS_FILE = resolve(PROJECT_ROOT, '.update-status.json');

async function runningInDocker(): Promise<boolean> {
  return access('/.dockerenv').then(
    () => true,
    () => false
  );
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
  app.get('/update/capability', { preHandler: [app.authenticate] }, async (request) => {
    const isOwner = request.user.role === 'owner';
    const docker = await runningInDocker();
    return {
      // Available only for the owner, on a bare-metal install, with self-update
      // explicitly enabled (the updater unit + sudoers must be set up on the host).
      available: isOwner && SELF_UPDATE_ENABLED && !docker,
      enabled: SELF_UPDATE_ENABLED,
      isDocker: docker,
    };
  });

  /**
   * POST /version/update
   * Trigger a self-update (owner only, bare-metal, opt-in). Kicks off the
   * tracearr-update.service unit which rebuilds and restarts in its own cgroup.
   */
  app.post('/update', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only the owner can update the server.');
    }
    if (!SELF_UPDATE_ENABLED) {
      return reply.badRequest(
        'In-app update is not enabled. Set TRACEARR_SELF_UPDATE=true and install the updater unit.'
      );
    }
    if (await runningInDocker()) {
      return reply.badRequest('Docker deployments update by pulling a new image, not this button.');
    }

    const latest = await getCachedLatestVersion();
    if (!latest || !isNewerVersion(latest.version, getCurrentVersion())) {
      return reply.badRequest('Already up to date.');
    }

    // Fire-and-forget: start the updater unit non-blocking so it survives this
    // process's own restart. No user input is passed to the command.
    try {
      const child = spawn('sudo', ['systemctl', 'start', '--no-block', 'tracearr-update.service'], {
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
    } catch (err) {
      request.log.error({ err }, 'Failed to start updater unit');
      return reply.internalServerError('Failed to start the updater.');
    }

    return { started: true, target: latest.version };
  });

  /**
   * GET /version/update/status
   * Read the updater's progress file (written by scripts/update.sh).
   */
  app.get('/update/status', { preHandler: [app.authenticate] }, async (request, reply) => {
    if (request.user.role !== 'owner') {
      return reply.forbidden('Only the owner can view update status.');
    }
    try {
      const raw = await readFile(UPDATE_STATUS_FILE, 'utf8');
      return JSON.parse(raw) as { state: string; message: string; at: string };
    } catch {
      return { state: 'idle', message: null, at: null };
    }
  });
};

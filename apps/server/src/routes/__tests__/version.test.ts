/**
 * Version / update route tests
 *
 * Covers GET /version/update/capability, POST /version/update, and
 * GET /version/update/status across both deployment modes:
 *  - bare metal (unchanged systemd-unit flow)
 *  - Docker (Portainer stack redeploy webhook)
 *
 * The webhook URL embeds the Portainer webhook UUID, which *is* the auth
 * secret (see routes/version.ts, services/settings.ts) - several tests
 * assert it never appears in any response body, even on failure paths.
 *
 * SELF_UPDATE_ENABLED is read from process.env at module-evaluation time, so
 * version.ts is loaded via a single dynamic import in beforeAll (after the
 * env var is set and before any other import of the module), rather than a
 * static top-level import - ESM import bindings evaluate before a module's
 * own top-level statements, so a plain `process.env.X = ...` written above a
 * static `import` would run too late.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '@tracearr/shared';

vi.mock('../../jobs/versionCheckQueue.js', () => ({
  getCurrentVersion: vi.fn(),
  getCurrentTag: vi.fn(),
  getCurrentCommit: vi.fn(),
  getBuildDate: vi.fn(),
  getCachedLatestVersion: vi.fn(),
  isNewerVersion: vi.fn(),
  isPrerelease: vi.fn(),
  forceVersionCheck: vi.fn(),
}));

vi.mock('../../services/settings.js', () => ({
  getDockerRedeployWebhookUrl: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import {
  getCurrentVersion,
  getCachedLatestVersion,
  isNewerVersion,
} from '../../jobs/versionCheckQueue.js';
import { getDockerRedeployWebhookUrl } from '../../services/settings.js';

// A realistic Portainer webhook URL - the trailing UUID *is* the secret.
const WEBHOOK_SECRET = 'a1b2c3d4-e5f6-47a8-9b0c-1d2e3f4a5b6c';
const WEBHOOK_URL = `http://portainer.local:9000/api/webhooks/${WEBHOOK_SECRET}`;
// A webhook URL an SSRF check must reject (link-local metadata range).
const LINK_LOCAL_WEBHOOK_URL = `http://169.254.169.254/api/webhooks/${WEBHOOK_SECRET}`;

function ownerUser(): AuthUser {
  return { userId: randomUUID(), username: 'owner', role: 'owner', serverIds: [] };
}
function viewerUser(): AuthUser {
  return { userId: randomUUID(), username: 'viewer', role: 'viewer', serverIds: [] };
}

/** Fails any response body containing the webhook secret UUID, verbatim or as a substring. */
function expectNoSecretLeak(body: unknown): void {
  expect(JSON.stringify(body)).not.toContain(WEBHOOK_SECRET);
}

/** access('/.dockerenv') resolves (Docker) or rejects (bare metal). */
function mockDocker(isDocker: boolean): void {
  vi.mocked(access).mockImplementation((path) => {
    if (isDocker && path === '/.dockerenv') return Promise.resolve();
    return Promise.reject(new Error('ENOENT'));
  });
}

describe('Version / update routes', () => {
  let versionRoutes: FastifyPluginAsync;
  let app: FastifyInstance;

  beforeAll(async () => {
    // Bare-metal opt-in flag - frozen into the module at import time.
    process.env.TRACEARR_SELF_UPDATE = 'true';
    ({ versionRoutes } = await import('../version.js'));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentVersion).mockReturnValue('1.0.0');
    vi.mocked(getCachedLatestVersion).mockResolvedValue({
      version: '2.0.0',
      tag: 'v2.0.0',
      releaseUrl: 'https://example.com/releases/2.0.0',
      publishedAt: '2026-01-01T00:00:00Z',
      isPrerelease: false,
      releaseName: null,
      releaseNotes: null,
      checkedAt: '2026-01-01T00:00:00Z',
    });
    vi.mocked(isNewerVersion).mockReturnValue(true);
    vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(null);
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, type: 'basic' }));
  });

  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
  });

  async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
    const testApp = Fastify({ logger: false });
    await testApp.register(sensible);
    testApp.decorate('authenticate', async (request: { user: AuthUser }) => {
      request.user = authUser;
    });
    await testApp.register(versionRoutes, { prefix: '/version' });
    return testApp;
  }

  // ==========================================================================
  // GET /version/update/capability
  // ==========================================================================

  describe('GET /version/update/capability', () => {
    it('Docker + webhook configured: available, configured, tag-pinning note', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(WEBHOOK_URL);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/capability' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        available: true,
        isDocker: true,
        dockerRedeployConfigured: true,
      });
      expect(body.dockerNote).toMatch(/moving tag/i);
      expectNoSecretLeak(body);
    });

    it('Docker + no webhook configured: unavailable, explains how to enable', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(null);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/capability' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        available: false,
        isDocker: true,
        dockerRedeployConfigured: false,
      });
      expect(body.dockerNote).toMatch(/configure/i);
    });

    it('bare metal: existing available/enabled logic unaffected, docker fields inert', async () => {
      mockDocker(false);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/capability' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        available: true, // SELF_UPDATE_ENABLED=true, !docker
        enabled: true,
        isDocker: false,
        dockerRedeployConfigured: false,
        dockerNote: null,
      });
      // Bare metal never even reads the setting.
      expect(getDockerRedeployWebhookUrl).not.toHaveBeenCalled();
    });

    it('non-owner: never available regardless of deployment mode', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(WEBHOOK_URL);
      app = await buildTestApp(viewerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/capability' });

      expect(response.statusCode).toBe(200);
      expect(response.json().available).toBe(false);
    });
  });

  // ==========================================================================
  // POST /version/update
  // ==========================================================================

  describe('POST /version/update', () => {
    it('forbids non-owners', async () => {
      app = await buildTestApp(viewerUser());
      const response = await app.inject({ method: 'POST', url: '/version/update' });
      expect(response.statusCode).toBe(403);
    });

    it('Docker + webhook configured + update available: fires the webhook, never echoes it', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(WEBHOOK_URL);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ started: true, target: '2.0.0' });
      expect(body.note).toMatch(/cannot report further progress/i);
      expectNoSecretLeak(body);

      expect(fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0]!;
      expect(calledUrl).toBe(WEBHOOK_URL);
      expect(calledInit).toMatchObject({ method: 'POST', redirect: 'manual' });
      // No systemd unit spawned on the Docker path.
      expect(spawn).not.toHaveBeenCalled();
    });

    it('Docker + no webhook configured: keeps the existing rejection message', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(null);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain(
        'Docker deployments update by pulling a new image, not this button.'
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('Docker + webhook configured + already up to date: rejects before firing the webhook', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(WEBHOOK_URL);
      vi.mocked(isNewerVersion).mockReturnValue(false);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Already up to date.');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('Docker + link-local webhook URL: SSRF rejection never leaks the URL', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(LINK_LOCAL_WEBHOOK_URL);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(500);
      const body = response.json();
      expectNoSecretLeak(body);
      expect(JSON.stringify(body)).not.toContain('169.254');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('Docker + webhook fails at call time: generic failure message, never leaks the URL', async () => {
      mockDocker(true);
      vi.mocked(getDockerRedeployWebhookUrl).mockResolvedValue(WEBHOOK_URL);
      // Worst case: the thrown error itself embeds the URL (as some HTTP
      // client internals do) - the route must still never surface it.
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValue(new Error(`request to ${WEBHOOK_URL} failed, reason: ECONNREFUSED`))
      );
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(500);
      expectNoSecretLeak(response.json());
    });

    it('bare metal: unchanged - spawns the updater unit when a newer version is available', async () => {
      mockDocker(false);
      vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as never);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ started: true, target: '2.0.0' });
      expect(spawn).toHaveBeenCalledWith(
        'sudo',
        ['systemctl', 'start', '--no-block', 'tracearr-update.service'],
        expect.anything()
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(getDockerRedeployWebhookUrl).not.toHaveBeenCalled();
    });

    it('bare metal: already up to date', async () => {
      mockDocker(false);
      vi.mocked(isNewerVersion).mockReturnValue(false);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'POST', url: '/version/update' });

      expect(response.statusCode).toBe(400);
      expect(response.json().message).toContain('Already up to date.');
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // GET /version/update/status
  // ==========================================================================

  describe('GET /version/update/status', () => {
    it('forbids non-owners', async () => {
      app = await buildTestApp(viewerUser());
      const response = await app.inject({ method: 'GET', url: '/version/update/status' });
      expect(response.statusCode).toBe(403);
    });

    it("Docker: reports a fixed 'unknown' state, never reads the status file", async () => {
      mockDocker(true);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/status' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ state: 'unknown', at: null });
      expect(response.json().message).toMatch(/cannot report update progress/i);
      expect(readFile).not.toHaveBeenCalled();
    });

    it('bare metal: idle when no status file exists yet (unchanged)', async () => {
      mockDocker(false);
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/status' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ state: 'idle', message: null, at: null });
    });

    it('bare metal: relays the parsed status file contents (unchanged)', async () => {
      mockDocker(false);
      vi.mocked(readFile).mockResolvedValue(
        JSON.stringify({ state: 'running', message: 'Building', at: '2026-01-01T00:00:00Z' })
      );
      app = await buildTestApp(ownerUser());

      const response = await app.inject({ method: 'GET', url: '/version/update/status' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        state: 'running',
        message: 'Building',
        at: '2026-01-01T00:00:00Z',
      });
    });
  });
});

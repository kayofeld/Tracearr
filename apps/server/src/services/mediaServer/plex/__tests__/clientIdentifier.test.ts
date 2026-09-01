/**
 * The PIN request and the auth URL carry the client identifier separately.
 * plex.tv scopes a PIN to the identifier that created it, so if those two drift
 * apart the user authorises against a different device and polling never
 * resolves - the popup just spins. These tests pin them together.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async () => {
  const actual = await vi.importActual<typeof HttpModule>('../../../../utils/http.js');
  return { ...actual, fetchJson: vi.fn(), fetchText: vi.fn() };
});

import { PlexClient } from '../client.js';
import {
  fetchJson,
  plexHeaders,
  setPlexClientIdentifier,
  getPlexClientIdentifier,
} from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

beforeEach(() => {
  mockFetchJson.mockReset();
  mockFetchJson.mockResolvedValue({ id: 987654321, code: 'abcd' });
});

afterEach(() => setPlexClientIdentifier('tracearr'));

describe('plex client identifier consistency', () => {
  it('sends the per-install identifier on the pin request', async () => {
    setPlexClientIdentifier('11112222-3333-4444-5555-666677778888');

    await PlexClient.initiateOAuth();

    const [, options] = mockFetchJson.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(options.headers['X-Plex-Client-Identifier']).toBe(
      '11112222-3333-4444-5555-666677778888'
    );
  });

  it('puts the same identifier in the auth URL as in the pin request', async () => {
    setPlexClientIdentifier('11112222-3333-4444-5555-666677778888');

    const { authUrl } = await PlexClient.initiateOAuth();

    const [, options] = mockFetchJson.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const urlClientId = new URLSearchParams(authUrl.split('#?')[1]).get('clientID');

    expect(urlClientId).toBe(options.headers['X-Plex-Client-Identifier']);
    expect(urlClientId).toBe(getPlexClientIdentifier());
  });

  it('never falls back to the shared constant once an identifier is set', async () => {
    setPlexClientIdentifier('per-install-value');

    const { authUrl } = await PlexClient.initiateOAuth();

    expect(authUrl).not.toContain('clientID=tracearr');
    expect(plexHeaders()['X-Plex-Client-Identifier']).not.toBe('tracearr');
  });
});

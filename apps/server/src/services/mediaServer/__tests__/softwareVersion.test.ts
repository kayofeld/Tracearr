import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../utils/http.js';

vi.mock('../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson } from '../../../utils/http.js';
import { EmbyClient } from '../emby/client.js';
import { JellyfinClient } from '../jellyfin/client.js';
import { PlexClient } from '../plex/client.js';

const mockFetchJson = vi.mocked(fetchJson);

const PLEX_URL = 'http://plex.local:32400';
const JELLYFIN_URL = 'http://jellyfin.local:8096';
const EMBY_URL = 'http://emby.local:8096';

describe('getSoftwareVersion', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('reads the Plex version off /identity', async () => {
    mockFetchJson.mockResolvedValue({
      MediaContainer: { machineIdentifier: 'abc', version: '1.43.3.10896-cb3ebc72d' },
    });

    const version = await new PlexClient({ url: PLEX_URL, token: 't' }).getSoftwareVersion();

    expect(version).toBe('1.43.3.10896-cb3ebc72d');
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${PLEX_URL}/identity`,
      expect.objectContaining({ service: 'plex' })
    );
  });

  it('reads the Jellyfin version off System/Info', async () => {
    mockFetchJson.mockResolvedValue({ Id: 'abc', Version: '10.11.11' });

    const version = await new JellyfinClient({
      url: JELLYFIN_URL,
      token: 't',
    }).getSoftwareVersion();

    expect(version).toBe('10.11.11');
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${JELLYFIN_URL}/System/Info`,
      expect.objectContaining({ service: 'jellyfin' })
    );
  });

  it('reads the Emby version off System/Info', async () => {
    mockFetchJson.mockResolvedValue({ Id: 'abc', Version: '4.9.5.0' });

    const version = await new EmbyClient({ url: EMBY_URL, token: 't' }).getSoftwareVersion();

    expect(version).toBe('4.9.5.0');
    expect(mockFetchJson).toHaveBeenCalledWith(
      `${EMBY_URL}/System/Info`,
      expect.objectContaining({ service: 'emby' })
    );
  });

  it('reports nothing when the server names no version', async () => {
    mockFetchJson.mockResolvedValue({ MediaContainer: {} });
    await expect(new PlexClient({ url: PLEX_URL, token: 't' }).getSoftwareVersion()).resolves.toBe(
      null
    );

    mockFetchJson.mockResolvedValue({ Id: 'abc' });
    await expect(
      new EmbyClient({ url: EMBY_URL, token: 't' }).getSoftwareVersion()
    ).resolves.toBeNull();
  });

  it('still reads the identity off the same System/Info body', async () => {
    mockFetchJson.mockResolvedValue({ Id: 'abc', Version: '10.11.11' });

    await expect(
      new JellyfinClient({ url: JELLYFIN_URL, token: 't' }).getServerIdentity()
    ).resolves.toBe('abc');
  });
});

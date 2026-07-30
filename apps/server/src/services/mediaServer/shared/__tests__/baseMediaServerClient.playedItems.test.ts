/**
 * Tests for BaseMediaServerClient.getPlayedItems (docs/architecture/emby-played-state-sync.md
 * §3, §6.4). Shared implementation - exercised through both JellyfinClient and EmbyClient to
 * confirm the identical-API-shape assumption holds for the Jellyfin path too (§3: "verified on
 * Emby only... the build must confirm against a Jellyfin instance or a recorded fixture").
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JellyfinClient } from '../../jellyfin/client.js';
import { EmbyClient } from '../../emby/client.js';

vi.mock('../../../../utils/http.js', () => ({
  fetchJson: vi.fn(),
  jellyfinEmbyHeaders: vi.fn().mockReturnValue({}),
}));

import { fetchJson } from '../../../../utils/http.js';

const mockFetchJson = vi.mocked(fetchJson);

function makeItemsResponse(items: unknown[] = [], totalRecordCount?: number) {
  return { Items: items, TotalRecordCount: totalRecordCount ?? items.length };
}

beforeEach(() => {
  vi.clearAllMocks();
});

const clientFactories = {
  Jellyfin: () => new JellyfinClient({ url: 'http://jellyfin.local:8096', token: 'test-token' }),
  Emby: () => new EmbyClient({ url: 'http://emby.local:8096', token: 'test-token' }),
};

describe.each(Object.entries(clientFactories))('%s getPlayedItems', (_name, makeClient) => {
  it('requests /Users/{id}/Items with IsPlayed=true and the expected item types', async () => {
    mockFetchJson.mockResolvedValue(makeItemsResponse());

    const client = makeClient();
    await client.getPlayedItems('user-1');

    const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('/Users/user-1/Items?');
    expect(calledUrl).toContain('IsPlayed=true');
    expect(calledUrl).toContain('Recursive=true');
    expect(calledUrl).toContain('IncludeItemTypes=Movie%2CEpisode');
    expect(calledUrl).toContain('Fields=UserData');
    expect(calledUrl).toContain('EnableTotalRecordCount=true');
  });

  it('passes offset/limit as StartIndex/Limit', async () => {
    mockFetchJson.mockResolvedValue(makeItemsResponse());

    const client = makeClient();
    await client.getPlayedItems('user-1', { offset: 5000, limit: 5000 });

    const calledUrl = mockFetchJson.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain('StartIndex=5000');
    expect(calledUrl).toContain('Limit=5000');
  });

  it('maps a movie row: Id -> ratingKey, Type -> mediaType', async () => {
    mockFetchJson.mockResolvedValue(
      makeItemsResponse([
        {
          Id: 'movie-1',
          Type: 'Movie',
          UserData: { LastPlayedDate: '2026-07-01T00:00:00.000Z', PlayCount: 3 },
        },
      ])
    );

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      ratingKey: 'movie-1',
      mediaType: 'movie',
      playCount: 3,
    });
    expect(result.items[0]!.seriesRatingKey).toBeUndefined();
    expect(result.items[0]!.playedAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('maps an episode row: SeriesId -> seriesRatingKey', async () => {
    mockFetchJson.mockResolvedValue(
      makeItemsResponse([
        {
          Id: 'ep-1',
          Type: 'Episode',
          SeriesId: 'show-1',
          UserData: { LastPlayedDate: '2026-07-01T00:00:00.000Z', PlayCount: 1 },
        },
      ])
    );

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.items[0]).toMatchObject({
      ratingKey: 'ep-1',
      mediaType: 'episode',
      seriesRatingKey: 'show-1',
    });
  });

  it('treats PlayCount: 0 / LastPlayedDate: null (historical plays) as played, not filtered out', async () => {
    mockFetchJson.mockResolvedValue(
      makeItemsResponse([
        {
          Id: 'movie-historical',
          Type: 'Movie',
          UserData: { LastPlayedDate: null, PlayCount: 0 },
        },
      ])
    );

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      ratingKey: 'movie-historical',
      mediaType: 'movie',
      playCount: 0,
    });
    expect(result.items[0]!.playedAt).toBeUndefined();
  });

  it('drops rows with no Id and rows whose Type is neither Movie nor Episode', async () => {
    mockFetchJson.mockResolvedValue(
      makeItemsResponse([
        { Id: '', Type: 'Movie' },
        { Id: 'season-1', Type: 'Season' },
        { Id: 'movie-ok', Type: 'Movie' },
      ])
    );

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.ratingKey).toBe('movie-ok');
  });

  it('returns totalCount from TotalRecordCount, independent of the page size returned', async () => {
    mockFetchJson.mockResolvedValue(makeItemsResponse([{ Id: 'movie-1', Type: 'Movie' }], 18381));

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.totalCount).toBe(18381);
    expect(result.items).toHaveLength(1);
  });

  it('returns empty result when the server has no played items for the user', async () => {
    mockFetchJson.mockResolvedValue({ Items: [] });

    const client = makeClient();
    const result = await client.getPlayedItems('user-1');

    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

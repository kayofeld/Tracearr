import { describe, it, expect } from 'vitest';
import { buildMediaServerItemUrl } from '../mediaServerLinks.js';

const PLEX_MACHINE = '02aede436384ae67d1d1dc879dcd69f8504c27ca';
const EMBY_SERVER = 'a1c97fc391d842678fb3f3a4cb42e185';

describe('buildMediaServerItemUrl', () => {
  it('sends Plex through app.plex.tv with the encoded metadata key', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'plex',
        baseUrl: 'http://192.168.1.10:32400',
        ratingKey: '2733',
        machineIdentifier: PLEX_MACHINE,
      })
    ).toBe(
      `https://app.plex.tv/desktop/#!/server/${PLEX_MACHINE}/details?key=%2Flibrary%2Fmetadata%2F2733`
    );
  });

  it('builds an Emby link with the bang prefix and its serverId', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'emby',
        baseUrl: 'http://media.example.com:8096',
        ratingKey: '2539',
        machineIdentifier: EMBY_SERVER,
      })
    ).toBe(`http://media.example.com:8096/web/index.html#!/item?id=2539&serverId=${EMBY_SERVER}`);
  });

  it('builds a Jellyfin link with no bang and no serverId', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://media.example.com:8096',
        ratingKey: 'bf01da2708ae716a7d2bd441376de12f',
      })
    ).toBe(
      'http://media.example.com:8096/web/index.html#/details?id=bf01da2708ae716a7d2bd441376de12f'
    );
  });

  it('does not double the slash when the configured url has a trailing one', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://media.example.com:8096/',
        ratingKey: 'abc',
      })
    ).toBe('http://media.example.com:8096/web/index.html#/details?id=abc');
  });

  it('returns null for Plex and Emby when the server identifier is unknown', () => {
    expect(
      buildMediaServerItemUrl({ serverType: 'plex', baseUrl: 'http://x:32400', ratingKey: '1' })
    ).toBeNull();
    expect(
      buildMediaServerItemUrl({ serverType: 'emby', baseUrl: 'http://x:8096', ratingKey: '1' })
    ).toBeNull();
  });

  it('returns null without a rating key', () => {
    expect(
      buildMediaServerItemUrl({
        serverType: 'jellyfin',
        baseUrl: 'http://x:8096',
        ratingKey: '',
      })
    ).toBeNull();
  });
});

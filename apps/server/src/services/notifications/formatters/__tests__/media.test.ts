/**
 * Naming for the two media events, against the shapes the three servers really send:
 * a Plex season titled "Season 3", an Emby season titled "All Systems Red", and
 * episodes that carry their show and their place in it.
 */

import { describe, expect, it } from 'vitest';
import {
  formatMediaAddedMessage,
  formatMediaUpgradedMessage,
  mediaHeadline,
  mediaSubtitle,
  qualityMoves,
  seasonLabel,
} from '../media.js';
import type { MediaEventPayload, MediaUpgradedPayload } from '../../events.js';

const quality = {
  resolution: '1080p',
  dynamicRange: 'sdr',
  videoCodec: 'H264',
  audioCodec: 'AC3',
  audioChannels: 6,
  fileSize: 8_000_000_000,
};

const payload = (overrides: Partial<MediaEventPayload> = {}): MediaEventPayload => ({
  serverId: 'server-1',
  serverName: 'Guardian',
  serverType: 'plex',
  libraryItemId: 'item-1',
  ratingKey: 'rk-1',
  mediaId: null,
  title: 'Cars',
  grandparentTitle: null,
  parentTitle: null,
  grandparentRatingKey: null,
  parentRatingKey: null,
  parentIndex: null,
  itemIndex: null,
  mediaType: 'movie',
  year: 2006,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  thumbPath: null,
  libraryName: 'Movies',
  to: quality,
  ...overrides,
});

/** Plex names a season "Season 3"; the show is in parentTitle. */
const plexSeason = (overrides: Partial<MediaEventPayload> = {}) =>
  payload({
    title: 'Season 1',
    mediaType: 'season',
    parentTitle: 'Ted Lasso',
    parentIndex: 1,
    libraryName: 'TV Shows',
    year: 2020,
    ...overrides,
  });

/** Emby names a season after itself; the show still arrives as SeriesName. */
const embySeason = (overrides: Partial<MediaEventPayload> = {}) =>
  payload({
    title: 'All Systems Red',
    mediaType: 'season',
    parentTitle: 'Murderbot',
    parentIndex: 1,
    libraryName: 'TV Shows',
    year: 2025,
    ...overrides,
  });

const episode = (overrides: Partial<MediaEventPayload> = {}) =>
  payload({
    title: 'Homicide Homecoming',
    mediaType: 'episode',
    grandparentTitle: '911: Did the Killer Call?',
    parentTitle: 'Season 2',
    parentIndex: 2,
    itemIndex: 7,
    libraryName: 'TV Shows',
    year: 2026,
    ...overrides,
  });

describe('seasonLabel', () => {
  it('uses the index for the number, not the title', () => {
    expect(seasonLabel(plexSeason({ title: 'Season 1', parentIndex: 3 }))).toBe('Season 3');
  });

  it('keeps a real season name alongside the number', () => {
    expect(seasonLabel(embySeason())).toBe('Season 1: All Systems Red');
  });

  it('falls back to the title when the server sent no index', () => {
    expect(seasonLabel(embySeason({ parentIndex: null }))).toBe('All Systems Red');
  });

  it('renders Specials as season zero rather than hiding it', () => {
    expect(seasonLabel(plexSeason({ title: 'Specials', parentIndex: 0 }))).toBe(
      'Season 0: Specials'
    );
  });
});

describe('mediaHeadline', () => {
  it('names the show a season belongs to', () => {
    expect(mediaHeadline(plexSeason())).toBe('Ted Lasso — Season 1');
    expect(mediaHeadline(embySeason())).toBe('Murderbot — Season 1: All Systems Red');
  });

  it('names the show and the place in it for an episode', () => {
    expect(mediaHeadline(episode())).toBe('911: Did the Killer Call? — S02 · E07');
  });

  it('falls back to the episode title when the numbers are missing', () => {
    expect(mediaHeadline(episode({ parentIndex: null, itemIndex: null }))).toBe(
      '911: Did the Killer Call? — Homicide Homecoming'
    );
  });

  it('lets a film name itself', () => {
    expect(mediaHeadline(payload())).toBe('Cars');
  });

  it('does not lose a season whose show never arrived', () => {
    expect(mediaHeadline(plexSeason({ parentTitle: null }))).toBe('Season 1');
  });
});

describe('mediaSubtitle', () => {
  it('gives an episode its own title, which the headline replaced with a code', () => {
    expect(mediaSubtitle(episode())).toBe('Homicide Homecoming');
  });

  it('gives a named season its name and a numbered one nothing', () => {
    expect(mediaSubtitle(embySeason())).toBe('All Systems Red');
    expect(mediaSubtitle(plexSeason())).toBeNull();
  });
});

describe('formatMediaAddedMessage', () => {
  it('names the item, the library and the server', () => {
    expect(formatMediaAddedMessage(payload())).toBe('Cars (2006) was added to Movies on Guardian');
  });

  it('quotes the episode title so the code is not the whole message', () => {
    expect(formatMediaAddedMessage(episode())).toBe(
      '911: Did the Killer Call? — S02 · E07 (2026) "Homicide Homecoming" was added to TV Shows on Guardian'
    );
  });

  it('counts the episodes a season swallowed', () => {
    expect(formatMediaAddedMessage(embySeason({ addedEpisodeCount: 4 }))).toBe(
      'Murderbot — Season 1: All Systems Red (2025) — 4 episodes added to TV Shows on Guardian'
    );
  });

  it('says one episode, not one episodes', () => {
    expect(formatMediaAddedMessage(plexSeason({ addedEpisodeCount: 1 }))).toContain(
      '1 episode added'
    );
  });

  it('does not claim zero episodes when a season arrived ahead of them', () => {
    expect(formatMediaAddedMessage(embySeason({ addedEpisodeCount: 0 }))).toBe(
      'Murderbot — Season 1: All Systems Red (2025) was added to TV Shows on Guardian'
    );
  });

  it('drops the year when the server reported none', () => {
    expect(formatMediaAddedMessage(payload({ year: null }))).toBe(
      'Cars was added to Movies on Guardian'
    );
  });
});

describe('qualityMoves and formatMediaUpgradedMessage', () => {
  const upgraded = (changed: (keyof typeof quality)[]): MediaUpgradedPayload => ({
    ...payload(),
    from: quality,
    to: { ...quality, resolution: '4k', fileSize: 42_000_000_000 },
    changed,
  });

  it('puts the resolution first however the changed list is ordered', () => {
    expect(qualityMoves(upgraded(['fileSize', 'resolution'])).map((m) => m.label)).toEqual([
      'Resolution',
      'Size',
    ]);
  });

  it('spells sizes in GB and resolutions the way the UI does', () => {
    expect(qualityMoves(upgraded(['resolution', 'fileSize']))).toEqual([
      { label: 'Resolution', move: '1080p → 4K' },
      { label: 'Size', move: '7.5 GB → 39.1 GB' },
    ]);
  });

  it('names every field that moved, not just the first', () => {
    expect(formatMediaUpgradedMessage(upgraded(['resolution', 'fileSize']))).toBe(
      'Cars (2006) on Guardian was upgraded: resolution 1080p → 4K, size 7.5 GB → 39.1 GB'
    );
  });

  it('says only that it was upgraded when nothing is listed as moved', () => {
    expect(formatMediaUpgradedMessage(upgraded([]))).toBe('Cars (2006) on Guardian was upgraded');
  });
});

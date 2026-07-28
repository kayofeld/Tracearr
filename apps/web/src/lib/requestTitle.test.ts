import { describe, it, expect } from 'vitest';
import { resolveRequestTitle } from './requestTitle';

describe('resolveRequestTitle (ADR 0007)', () => {
  it('prefers the request title when present (the Ombi case - always non-null)', () => {
    expect(resolveRequestTitle('The Matrix', 'Matrix, The', 603)).toBe('The Matrix');
  });

  it('falls back to the matched library item title when the request title is null (Seerr v1)', () => {
    expect(resolveRequestTitle(null, 'The Matrix', 603)).toBe('The Matrix');
  });

  it('falls back to a TMDB-id placeholder when neither title is available', () => {
    expect(resolveRequestTitle(null, null, 603)).toBe('TMDB #603');
  });

  it('falls back to a TMDB-id placeholder built from a string id', () => {
    expect(resolveRequestTitle(undefined, undefined, '603')).toBe('TMDB #603');
  });

  it('never renders blank - falls back to a generic placeholder as the last resort', () => {
    expect(resolveRequestTitle(null, null, null)).toBe('Unknown title');
    expect(resolveRequestTitle(undefined, undefined, undefined)).toBe('Unknown title');
  });

  it('treats an empty-string title as absent, not as a valid title', () => {
    expect(resolveRequestTitle('', 'The Matrix', 603)).toBe('The Matrix');
  });
});

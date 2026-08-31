import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELDS,
  IDENTITY_AWARE_CONDITION_FIELDS,
  conditionGroupSchema,
  conditionSchema,
  fieldsAvailableFor,
} from '../index.js';

const id = '3f2c8f0e-1c4d-4c1a-9c2e-6f0b6f5c9a11';

describe('condition field descriptors', () => {
  it('gives every field at least one operator', () => {
    for (const descriptor of Object.values(CONDITION_FIELDS)) {
      expect(descriptor.operators.length).toBeGreaterThan(0);
    }
  });

  it('marks the cross-session fields identity aware', () => {
    expect(IDENTITY_AWARE_CONDITION_FIELDS).toContain('concurrent_streams');
    expect(IDENTITY_AWARE_CONDITION_FIELDS).not.toContain('trust_score');
  });

  it('widens the offer as the context narrows', () => {
    const account = fieldsAvailableFor('account');
    expect(account).toContain('inactive_days');
    expect(account).not.toContain('is_transcoding');
    expect(fieldsAvailableFor('session')).toContain('is_transcoding');
    expect(fieldsAvailableFor('session')).not.toContain('library_name');
    expect(fieldsAvailableFor(null)).toEqual(Object.keys(CONDITION_FIELDS));
  });

  it('offers a media trigger its own fields and the server it names', () => {
    expect(fieldsAvailableFor('media')).toEqual([
      'server_id',
      'library_item_type',
      'library_name',
      'resolution_after',
      'dynamic_range_after',
      'video_codec_after',
      'audio_channels_after',
      'file_size_after',
    ]);
    expect(fieldsAvailableFor('server')).toEqual(['server_id']);
  });
});

describe('condition nodes', () => {
  it('keeps its id and enabled flag through a parse', () => {
    const condition = { id, enabled: false, field: 'trust_score', operator: 'lt', value: 50 };
    expect(conditionSchema.parse(condition)).toEqual(condition);
  });

  it('rejects an id that is not a uuid', () => {
    expect(
      conditionSchema.safeParse({ id: 'nope', field: 'trust_score', operator: 'lt', value: 1 })
        .success
    ).toBe(false);
  });

  it('parses a node without the optional fields', () => {
    expect(
      conditionSchema.safeParse({ field: 'trust_score', operator: 'lt', value: 1 }).success
    ).toBe(true);
  });

  it('takes an optional match on a group', () => {
    const conditions = [{ field: 'trust_score', operator: 'lt', value: 1 }];
    expect(conditionGroupSchema.parse({ conditions }).match).toBeUndefined();
    expect(conditionGroupSchema.parse({ match: 'all', conditions }).match).toBe('all');
    expect(conditionGroupSchema.safeParse({ match: 'either', conditions }).success).toBe(false);
  });
});

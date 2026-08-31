import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_TYPES,
  LEAF_ACTION_TYPES,
  actionSchema,
  actionTypeSchema,
  ifActionSchema,
  leafActionSchema,
  sendActionSchema,
  trustActionSchema,
} from '../index.js';

const id = '3f2c8f0e-1c4d-4c1a-9c2e-6f0b6f5c9a11';

describe('send action', () => {
  it('takes no empty title or body, which would send a blank one', () => {
    const send = (over: Record<string, unknown>) => ({ type: 'send', to: [id], ...over });
    expect(sendActionSchema.safeParse(send({})).success).toBe(true);
    expect(sendActionSchema.safeParse(send({ title: 'Now playing' })).success).toBe(true);
    expect(sendActionSchema.safeParse(send({ title: '' })).success).toBe(false);
    expect(sendActionSchema.safeParse(send({ body: '' })).success).toBe(false);
  });
});

describe('trust action', () => {
  it('pairs mode with its parameter', () => {
    expect(
      trustActionSchema.safeParse({ type: 'trust', mode: 'adjust', amount: -10 }).success
    ).toBe(true);
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'set', value: 50 }).success).toBe(
      true
    );
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'reset' }).success).toBe(true);
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'adjust' }).success).toBe(false);
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'set' }).success).toBe(false);
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'reset', amount: 5 }).success).toBe(
      false
    );
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'adjust', value: 5 }).success).toBe(
      false
    );
    expect(trustActionSchema.safeParse({ type: 'trust', mode: 'set', amount: 5 }).success).toBe(
      false
    );
  });

  it('is the only trust member of the action union', () => {
    expect(actionTypeSchema.safeParse('trust').success).toBe(true);
    expect(actionSchema.safeParse({ type: 'trust', mode: 'reset' }).success).toBe(true);
    expect(actionSchema.safeParse({ type: 'adjust_trust', amount: -10 }).success).toBe(false);
  });

  it('the union rejects a mismatched mode and parameter', () => {
    expect(actionSchema.safeParse({ type: 'trust', mode: 'set', amount: 5 }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'trust', mode: 'adjust' }).success).toBe(false);
  });
});

describe('action nodes', () => {
  it('keeps its id and enabled flag through a parse', () => {
    const action = { id, enabled: false, type: 'kill_stream', delay_seconds: 10 };
    expect(actionSchema.parse(action)).toEqual(action);
    const trust = { id, enabled: true, type: 'trust', mode: 'set', value: 20 };
    expect(actionSchema.parse(trust)).toEqual(trust);
  });

  it('rejects an id that is not a uuid', () => {
    expect(actionSchema.safeParse({ id: 'nope', type: 'trust', mode: 'reset' }).success).toBe(
      false
    );
  });

  it('parses a node without the optional fields', () => {
    expect(actionSchema.safeParse({ type: 'trust', mode: 'reset' }).success).toBe(true);
  });
});

describe('action catalog', () => {
  it('adds if to the leaf types', () => {
    expect(LEAF_ACTION_TYPES).toEqual(['send', 'trust', 'kill_stream', 'message_client']);
    expect(ACTION_TYPES).toEqual([...LEAF_ACTION_TYPES, 'if']);
    expect(Object.keys(ACTIONS)).toEqual([...ACTION_TYPES]);
  });

  it('carries an optional title and body on send', () => {
    const send = { type: 'send', to: [id], title: 'Heads up', body: '{{user.username}}' };
    expect(sendActionSchema.parse(send)).toEqual(send);
    expect(sendActionSchema.safeParse({ type: 'send', to: [] }).success).toBe(false);
  });

  it('keeps if out of its own branches', () => {
    const branch = { type: 'if', conditions: { groups: [] }, then: [], else: [] };
    expect(ifActionSchema.safeParse(branch).success).toBe(true);
    expect(leafActionSchema.safeParse(branch).success).toBe(false);
    expect(
      ifActionSchema.safeParse({ ...branch, then: [{ type: 'message_client', message: 'hi' }] })
        .success
    ).toBe(true);
    expect(ifActionSchema.safeParse({ ...branch, then: [branch] }).success).toBe(false);
  });
});

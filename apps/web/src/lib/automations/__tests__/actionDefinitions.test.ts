import { beforeAll, describe, expect, it } from 'vitest';
import { i18n, initI18n } from '@tracearr/translations';
import { trustActionSchema } from '@tracearr/shared';
import {
  applyActionFieldChange,
  createDefaultAction,
  storedActionLabel,
} from '../actionDefinitions';
import type { Translate } from '../conditionFields';

let t: Translate;

beforeAll(async () => {
  await initI18n({ lng: 'en' });
  t = i18n.getFixedT(null, 'pages');
});

describe('applyActionFieldChange', () => {
  it('swaps trust parameters when the mode changes, so every mode stays savable', () => {
    const adjust = createDefaultAction('trust');
    const set = applyActionFieldChange(adjust, 'mode', 'set');
    expect(set).toEqual({ type: 'trust', mode: 'set', value: 50 });
    expect(trustActionSchema.safeParse(set).success).toBe(true);

    const reset = applyActionFieldChange(set, 'mode', 'reset');
    expect(reset).toEqual({ type: 'trust', mode: 'reset' });
    expect(trustActionSchema.safeParse(reset).success).toBe(true);

    const back = applyActionFieldChange(reset, 'mode', 'adjust');
    expect(trustActionSchema.safeParse(back).success).toBe(true);
  });

  it('keeps the cooldown across a mode change', () => {
    const withCooldown = { ...createDefaultAction('trust'), cooldown_minutes: 15 };
    const next = applyActionFieldChange(withCooldown, 'mode', 'set');
    expect(next).toEqual({ type: 'trust', mode: 'set', value: 50, cooldown_minutes: 15 });
  });

  it('carries the node id and enabled flag through a mode change', () => {
    const stored = { ...createDefaultAction('trust'), id: 'e8b7d0f4', enabled: false };

    expect(applyActionFieldChange(stored, 'mode', 'set')).toEqual({
      type: 'trust',
      mode: 'set',
      value: 50,
      id: 'e8b7d0f4',
      enabled: false,
    });
  });

  it('merges plainly for every other field', () => {
    const kill = createDefaultAction('kill_stream');
    expect(applyActionFieldChange(kill, 'cooldown_minutes', 30)).toEqual({
      type: 'kill_stream',
      cooldown_minutes: 30,
    });
  });
});

describe('storedActionLabel', () => {
  it('reads a stored action type as its translated label', () => {
    expect(storedActionLabel(t, 'kill_stream')).toBe('Kill Stream');
    expect(storedActionLabel(t, 'message_client')).toBe('Message Client');
  });

  it('falls back to the stored value for an action this build does not know', () => {
    expect(storedActionLabel(t, 'quarantine')).toBe('quarantine');
  });
});

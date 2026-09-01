import { describe, expect, it } from 'vitest';
import { readOverride } from './overrides';

describe('readOverride', () => {
  it('reads an empty box as no override at all', () => {
    expect(readOverride('', 1)).toEqual({ value: null, invalid: false });
    expect(readOverride('   ', 1)).toEqual({ value: null, invalid: false });
  });

  it('takes a whole number at or above the floor', () => {
    expect(readOverride('90', 1)).toEqual({ value: 90, invalid: false });
    expect(readOverride(' 0 ', 0)).toEqual({ value: 0, invalid: false });
  });

  it('faults a number under the floor rather than clearing the override', () => {
    expect(readOverride('0', 1)).toEqual({ value: null, invalid: true });
  });

  it('faults anything that is not a whole number', () => {
    expect(readOverride('10m', 0)).toEqual({ value: null, invalid: true });
    expect(readOverride('1.5', 0)).toEqual({ value: null, invalid: true });
    expect(readOverride('-1', 0)).toEqual({ value: null, invalid: true });
  });
});

import { describe, expect, it } from 'vitest';
import { passesViolationRuleTypeFilter } from '../pushNotification.js';

describe('passesViolationRuleTypeFilter', () => {
  it('passes every rule when the filter is empty', () => {
    expect(passesViolationRuleTypeFilter([], null)).toBe(true);
    expect(passesViolationRuleTypeFilter([], 'impossible_travel')).toBe(true);
  });

  it('passes a null-type (V2) rule through a non-empty legacy filter', () => {
    expect(passesViolationRuleTypeFilter(['impossible_travel'], null)).toBe(true);
  });

  it('still excludes a typed rule that is not in the filter', () => {
    expect(passesViolationRuleTypeFilter(['impossible_travel'], 'concurrent_streams')).toBe(false);
  });

  it('passes a typed rule that is in the filter', () => {
    expect(passesViolationRuleTypeFilter(['impossible_travel'], 'impossible_travel')).toBe(true);
  });
});

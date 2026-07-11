import { describe, it, expect } from 'vitest';
import { buildViolationFilterParams } from './violationsFilters';

describe('buildViolationFilterParams', () => {
  it('returns all-undefined params when no filters are active', () => {
    const result = buildViolationFilterParams({
      severityFilter: 'all',
      acknowledgedFilter: 'all',
      personFilter: [],
      selectedServerIds: [],
    });

    expect(result).toEqual({
      serverIds: undefined,
      severity: undefined,
      acknowledged: undefined,
      userIds: undefined,
    });
  });

  it('maps severity, status, servers, and person filters through to the params', () => {
    const result = buildViolationFilterParams({
      severityFilter: 'high',
      acknowledgedFilter: 'acknowledged',
      personFilter: ['person-1'],
      selectedServerIds: ['server-a', 'server-b'],
    });

    expect(result).toEqual({
      serverIds: ['server-a', 'server-b'],
      severity: 'high',
      acknowledged: true,
      userIds: ['person-1'],
    });
  });

  it('maps a pending status filter to acknowledged: false', () => {
    const result = buildViolationFilterParams({
      severityFilter: 'all',
      acknowledgedFilter: 'pending',
      personFilter: [],
      selectedServerIds: [],
    });

    expect(result.acknowledged).toBe(false);
  });

  it('carries only the person filter when it is the sole active filter', () => {
    const result = buildViolationFilterParams({
      severityFilter: 'all',
      acknowledgedFilter: 'all',
      personFilter: ['person-42'],
      selectedServerIds: [],
    });

    expect(result).toEqual({
      serverIds: undefined,
      severity: undefined,
      acknowledged: undefined,
      userIds: ['person-42'],
    });
  });

  it('carries multiple selected people as a single userIds array', () => {
    const result = buildViolationFilterParams({
      severityFilter: 'all',
      acknowledgedFilter: 'all',
      personFilter: ['person-1', 'person-2', 'person-3'],
      selectedServerIds: [],
    });

    expect(result.userIds).toEqual(['person-1', 'person-2', 'person-3']);
  });

  it('produces the same params object shape used for both the list query and bulk select-all filters', () => {
    // This is the contract the bulk endpoints rely on: whatever the list is
    // currently showing is exactly what select-all is scoped to.
    const state = {
      severityFilter: 'warning' as const,
      acknowledgedFilter: 'pending' as const,
      personFilter: ['person-7', 'person-8'],
      selectedServerIds: ['server-a'],
    };

    const listParams = buildViolationFilterParams(state);
    const bulkFilters = buildViolationFilterParams(state);

    expect(listParams).toEqual(bulkFilters);
  });
});

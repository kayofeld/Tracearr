import { describe, it, expect } from 'vitest';
import { parseChartDate, buildPerServerSeries } from './chartUtils';

describe('parseChartDate', () => {
  it('parses an ISO date string to local midnight timestamp', () => {
    const ts = parseChartDate('2026-01-28');
    expect(ts).toBe(new Date('2026-01-28T00:00:00').getTime());
  });

  it('parses a PostgreSQL timestamp with space separator', () => {
    const ts = parseChartDate('2026-01-28 05:00:00+00');
    expect(ts).toBe(new Date('2026-01-28T05:00:00+00:00').getTime());
  });
});

describe('buildPerServerSeries', () => {
  const servers = [
    { id: 'srv-a', name: 'Alpha', color: '#E5A00D' },
    { id: 'srv-b', name: 'Beta', color: '#6366F1' },
  ];

  const rows = [
    { serverId: 'srv-b', date: '2026-01-01', count: 5 },
    { serverId: 'srv-a', date: '2026-01-01', count: 10 },
    { serverId: 'srv-a', date: '2026-01-02', count: 20 },
    { serverId: 'srv-b', date: '2026-01-02', count: 8 },
  ];

  it('returns one series per server in the order servers are provided', () => {
    const series = buildPerServerSeries(rows, servers, (r) => [
      new Date(r.date + 'T00:00:00').getTime(),
      r.count,
    ]);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ name: 'Alpha', color: '#E5A00D' });
    expect(series[1]).toMatchObject({ name: 'Beta', color: '#6366F1' });
  });

  it('assigns each row to the correct server series', () => {
    const series = buildPerServerSeries(rows, servers, (r) => [
      new Date(r.date + 'T00:00:00').getTime(),
      r.count,
    ]);
    const alpha = series[0] as { data: [number, number][] };
    expect(alpha.data).toHaveLength(2);
    // rows are sorted by x ascending
    expect(alpha.data[0]?.[1]).toBe(10);
    expect(alpha.data[1]?.[1]).toBe(20);

    const beta = series[1] as { data: [number, number][] };
    expect(beta.data).toHaveLength(2);
    expect(beta.data[0]?.[1]).toBe(5);
    expect(beta.data[1]?.[1]).toBe(8);
  });

  it('defaults to type=area and stacking=normal', () => {
    const series = buildPerServerSeries(rows, servers, (r) => [0, r.count]);
    expect(series[0]).toMatchObject({ type: 'area', stacking: 'normal' });
  });

  it('respects type=column override', () => {
    const series = buildPerServerSeries(rows, servers, (r) => [0, r.count], { type: 'column' });
    expect(series[0]).toMatchObject({ type: 'column' });
  });

  it('produces an empty data array for a server with no matching rows', () => {
    const series = buildPerServerSeries(
      rows.filter((r) => r.serverId === 'srv-a'),
      servers,
      (r) => [new Date(r.date + 'T00:00:00').getTime(), r.count]
    );
    const beta = series[1] as { data: unknown[] };
    expect(beta.data).toHaveLength(0);
  });

  it('uses undefined color when server.color is null', () => {
    const colorless = [{ id: 'srv-c', name: 'Gamma', color: null }];
    const series = buildPerServerSeries([], colorless, (_r) => [0, 0]);
    expect(series[0]).toMatchObject({ color: undefined });
  });

  it('returns an empty array when no servers are provided', () => {
    const series = buildPerServerSeries(rows, [], (r) => [0, r.count]);
    expect(series).toHaveLength(0);
  });
});

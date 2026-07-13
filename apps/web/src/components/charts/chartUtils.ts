import type Highcharts from 'highcharts';
import type { Server } from '@tracearr/shared';

/**
 * Parse a date string to timestamp for Highcharts datetime axis.
 * Handles ISO dates ("YYYY-MM-DD") and PostgreSQL timestamps ("YYYY-MM-DD HH:mm:ss+TZ").
 */
export function parseChartDate(dateStr: string): number {
  if (dateStr.includes(' ')) {
    // PostgreSQL timestamp: "2026-01-28 05:00:00+00" -> "2026-01-28T05:00:00+00:00"
    const normalized = dateStr.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    return new Date(normalized).getTime();
  }
  // Date-only: "2026-01-28" -> local midnight
  return new Date(dateStr + 'T00:00:00').getTime();
}

/**
 * Build one Highcharts series per server in stable server order.
 * Rows not matching any server in `servers` are silently dropped.
 */
export function buildPerServerSeries<T extends { serverId: string }>(
  rows: T[],
  servers: Pick<Server, 'id' | 'name' | 'color'>[],
  getPoint: (row: T) => [number, number],
  opts?: { type?: 'area' | 'column'; stacking?: 'normal' }
): Highcharts.SeriesOptionsType[] {
  const type = opts?.type ?? 'area';
  const stacking = opts?.stacking ?? 'normal';

  return servers.map((server) => {
    const serverRows = rows
      .filter((r) => r.serverId === server.id)
      .map(getPoint)
      .sort((a, b) => a[0] - b[0]);

    return {
      type,
      name: server.name,
      color: server.color ?? undefined,
      stacking,
      data: serverRows,
    };
  });
}

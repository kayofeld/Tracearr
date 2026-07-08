export function parseDottedVersion(v: string): number[] | null {
  if (!v) return null;
  const parts = v.split('.');
  if (parts.length < 3 || parts.length > 4) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : NaN));
  return nums.some(Number.isNaN) ? null : nums;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseDottedVersion(a) ?? [];
  const pb = parseDottedVersion(b) ?? [];
  for (let i = 0; i < 4; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na > nb ? 1 : -1;
  }
  return 0;
}

export function maxVersion(versions: string[]): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!parseDottedVersion(v)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}

export function parseHelloPayload(data: string): { version: string; server: string } | null {
  try {
    const raw = JSON.parse(data) as Record<string, unknown>;
    if (typeof raw.version !== 'string' || typeof raw.server !== 'string') return null;
    return { version: raw.version, server: raw.server };
  } catch {
    return null;
  }
}

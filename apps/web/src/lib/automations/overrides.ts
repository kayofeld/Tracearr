export interface Override {
  value: number | null;
  invalid: boolean;
}

/** An empty box means "no override"; anything else has to be a whole number the API accepts. */
export function readOverride(raw: string, min: number): Override {
  const trimmed = raw.trim();
  if (trimmed === '') return { value: null, invalid: false };
  if (!/^\d+$/.test(trimmed)) return { value: null, invalid: true };
  const parsed = Number.parseInt(trimmed, 10);
  return parsed < min ? { value: null, invalid: true } : { value: parsed, invalid: false };
}

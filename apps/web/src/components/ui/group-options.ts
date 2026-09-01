// Buckets options by their optional `group`, keeping first-seen order so callers
// render headings in the order their option list declares them.
export function groupOptions<T extends { group?: string }>(options: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const option of options) {
    const key = option.group ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(option);
    else groups.set(key, [option]);
  }
  return [...groups.entries()];
}

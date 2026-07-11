/**
 * Pure logic for the people multiselect trigger summary text, kept separate
 * from the component so the "all / one name / N people" rules are testable
 * without rendering. `resolveName` is injected rather than an options array
 * so callers can fall back to data outside the loaded options page (e.g. the
 * currently loaded violation rows) the same way the page's summary card does.
 */

export function summarizePersonSelection(
  selectedIds: string[],
  resolveName: (id: string) => string | undefined,
  allLabel: string,
  countLabel: (count: number) => string
): string {
  if (selectedIds.length === 0) return allLabel;
  if (selectedIds.length === 1) {
    const id = selectedIds[0];
    const name = id ? resolveName(id) : undefined;
    return name ?? countLabel(1);
  }
  return countLabel(selectedIds.length);
}

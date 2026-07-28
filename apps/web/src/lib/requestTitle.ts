/**
 * ADR 0007: Seerr's request payload carries no title, so `media_requests.title`
 * is null for Seerr rows in v1 (Ombi rows always have one). Display titles are
 * derived at query time instead of hydrated at sync time - no endpoint reads
 * `media_requests.title` directly today (the design doc's proportionality
 * argument), so every surface that COULD show a per-request title must apply
 * this fallback chain rather than ever rendering a blank cell:
 *
 *   request title -> matched library item's title -> "TMDB #<tmdbId>"
 *
 * No current UI surface in this build renders a raw per-request title (the
 * shipped Never Watched table renders `StaleItem.title`, which always comes
 * from `library_items` via the query-time join and is never null) - this is
 * the sanctioned entry point for the per-request list UI ADR 0007 defers.
 */
export function resolveRequestTitle(
  title: string | null | undefined,
  matchedLibraryTitle: string | null | undefined,
  tmdbId: number | string | null | undefined
): string {
  if (title) return title;
  if (matchedLibraryTitle) return matchedLibraryTitle;
  if (tmdbId !== null && tmdbId !== undefined && String(tmdbId).length > 0) {
    return `TMDB #${tmdbId}`;
  }
  return 'Unknown title';
}

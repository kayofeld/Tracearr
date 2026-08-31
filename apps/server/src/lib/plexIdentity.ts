/**
 * Per-install Plex client identifier.
 *
 * plex.tv scopes a PIN to the client identifier that created it, so a constant
 * shared across every Tracearr install lets any install redeem any other's PIN.
 * This generates one UUID per deployment and persists it.
 */

import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../services/settings.js';
import { setPlexClientIdentifier } from '../utils/http.js';

/**
 * Load this install's identifier, generating and persisting one on first boot.
 * Safe to call repeatedly; only the first call writes.
 */
export async function initializePlexClientIdentifier(): Promise<string> {
  const existing = await getSetting('plexClientIdentifier');
  if (existing) {
    setPlexClientIdentifier(existing);
    return existing;
  }

  const generated = randomUUID();
  await setSetting('plexClientIdentifier', generated);
  setPlexClientIdentifier(generated);
  return generated;
}

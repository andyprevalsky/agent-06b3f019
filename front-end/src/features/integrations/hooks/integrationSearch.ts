/** Shared token matching for integration category visibility. */
import { INTEGRATION_CATALOG } from '../config';
import type { IntegrationCatalogKey } from '../types';

export function integrationMatchesSearch(key: IntegrationCatalogKey, query: string): boolean {
  const entry = INTEGRATION_CATALOG[key];
  const text = `${entry.title} ${entry.aliases}`.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => text.includes(token));
}
export function hasIntegrationSearchResults(query: string, signedIn: boolean): boolean {
  return (Object.keys(INTEGRATION_CATALOG) as IntegrationCatalogKey[]).some(
    (key) =>
      (signedIn || !['compute', 'banks', 'meetingNotes'].includes(key)) &&
      integrationMatchesSearch(key, query),
  );
}

/**
 * Data domain — per-source connectivity (the agent gate).
 *
 * For each requested data source, reports whether its backing connector is
 * CONNECTED and, when not, a URL the user can follow to connect it. Split from
 * service.ts for max-lines compliance.
 */

import { SourceNotFoundError } from './errors';
import * as repo from './repo';
import { DATA_SOURCE_CONFIGS, type ValidSource } from './types';

export interface SourceStatus {
  source: string;
  connector: string | null;
  connected: boolean;
  connectUrl: string | null;
}

const DOCUMENT_PROVIDER_CONNECTORS: Record<string, string> = {
  chatgpt: 'chatgpt',
  claude: 'claude',
  apple_notes: 'apple_notes',
  obsidian: 'obsidian',
};

function connectorForSource(rawSource: string): string | null {
  if (rawSource in DATA_SOURCE_CONFIGS) {
    const source = rawSource as ValidSource;
    return DATA_SOURCE_CONFIGS[source].connector;
  }
  if (rawSource in DOCUMENT_PROVIDER_CONNECTORS) {
    return DOCUMENT_PROVIDER_CONNECTORS[rawSource];
  }
  throw new SourceNotFoundError(rawSource);
}

/**
 * The connect URL a not-yet-connected connector renders on its gate. This is a
 * STABLE per-connector route, not a pre-minted OAuth URL: minting the actual
 * OAuth link at probe time created a throwaway EmailCredential row on every
 * source-status probe (the FE re-mints fresh on click via the Integrations
 * path, and SMS opens a mobile connect page that mints on load), so the
 * pre-minted URL was always discarded — pure waste + orphaned credential rows.
 */
function connectUrlForConnector(connector: string): string {
  return `https://roselabs.ai/connect/${connector}`;
}

/**
 * For each requested source, report whether its backing connector is CONNECTED
 * and, when not, a URL the user can follow to connect it. Local sources
 * (connector === null) are always connected with no connect URL. Unknown source
 * keys raise SourceNotFoundError (mapped to 400 by the route).
 */
export async function getSourceStatus(userId: string, sources: string[]): Promise<SourceStatus[]> {
  const statuses: SourceStatus[] = [];
  for (const rawSource of sources) {
    const connector = connectorForSource(rawSource);
    if (connector === null) {
      statuses.push({ source: rawSource, connector: null, connected: true, connectUrl: null });
      continue;
    }
    const connected = await repo.isConnectorConnected(userId, connector);
    statuses.push({
      source: rawSource,
      connector,
      connected,
      connectUrl: connected ? null : connectUrlForConnector(connector),
    });
  }
  return statuses;
}

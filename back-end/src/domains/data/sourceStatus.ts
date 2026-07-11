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
import { startEmailOAuth } from '../integrations/oauthService';

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
 * Mint (or stub) the connect URL for a not-yet-connected connector. Gmail gets
 * a real OAuth start URL via the integrations service; every other connector
 * returns a stable stub landing page.
 */
async function connectUrlForConnector(userId: string, connector: string): Promise<string> {
  if (connector === 'gmail') {
    const { authUrl } = await startEmailOAuth(userId, 'gmail', null, null);
    return authUrl;
  }
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
      connectUrl: connected ? null : await connectUrlForConnector(userId, connector),
    });
  }
  return statuses;
}

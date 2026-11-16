/**
 * Data domain — per-source connectivity (the agent gate).
 *
 * For each requested data source, reports whether its backing connector is
 * CONNECTED and, when not, a URL the user can follow to connect it. Split from
 * service.ts for max-lines compliance.
 */

import { MEETING_NOTE_PROVIDERS, resolveTeamDataAccess } from '../../providers/teamAccess';
import { hasGoogleWorkspaceAccount } from '../../services/integrations/googleWorkspaceSync';
import { SourceNotFoundError } from './errors';
import * as repo from './repo';
import { DATA_SOURCE_CONFIGS, isGoogleGrepSource } from './types';
import { isSourceName } from './validate.normalize';

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
  fireflies: 'fireflies',
  fireflies_note: 'fireflies',
  fireflies_summary: 'fireflies',
  fireflies_transcript: 'fireflies',
  granola: 'granola',
  granola_note: 'granola',
  granola_summary: 'granola',
  granola_transcript: 'granola',
};

const MEETING = new Set<string>(MEETING_NOTE_PROVIDERS);

function connectorForSource(rawSource: string): string | null {
  if (isSourceName(rawSource)) {
    return DATA_SOURCE_CONFIGS[rawSource].connector;
  }
  // Own keys only: `toString` or `constructor` is not a document provider.
  if (Object.prototype.hasOwnProperty.call(DOCUMENT_PROVIDER_CONNECTORS, rawSource)) {
    return DOCUMENT_PROVIDER_CONNECTORS[rawSource];
  }
  throw new SourceNotFoundError(rawSource);
}

/**
 * Providers whose teammate grant serves this source in the default scope, so the reader's
 * own connector is not required. Shared Plaid items are read only under an explicit team
 * scope (grepTool and the explore agent skip that probe), so `transactions` is not here.
 */
function sharedProviders(rawSource: string): string[] {
  if (rawSource === 'email' || rawSource === 'gmail') return ['gmail'];
  if (rawSource === 'imessage' || rawSource === 'whatsapp') return [rawSource];
  if (rawSource === 'meeting_notes') return [...MEETING_NOTE_PROVIDERS];
  const connector = Object.prototype.hasOwnProperty.call(DOCUMENT_PROVIDER_CONNECTORS, rawSource)
    ? DOCUMENT_PROVIDER_CONNECTORS[rawSource]
    : undefined;
  return connector !== undefined && MEETING.has(connector) ? [connector] : [];
}

function needsGoogleWorkspaceGrant(rawSource: string): boolean {
  return isSourceName(rawSource) && isGoogleGrepSource(rawSource);
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
  const grants = sources.some((source) => sharedProviders(source).length > 0)
    ? await resolveTeamDataAccess(userId)
    : [];
  const shared = (source: string) =>
    grants.some((grant) => sharedProviders(source).includes(grant.provider));
  for (const rawSource of sources) {
    // One generic source requires either provider, never both. Keep the actual
    // provider identity for connected results and a working connect route otherwise.
    if (rawSource === 'meeting_notes') {
      const providers = ['granola', 'fireflies'];
      const connections = await Promise.all(
        providers.map(
          async (provider) =>
            grants.some((grant) => grant.provider === provider) ||
            (await repo.isConnectorConnected(userId, provider))
        )
      );
      const connectedIndex = connections.findIndex(Boolean);
      const connector = providers[connectedIndex < 0 ? 0 : connectedIndex];
      const connected = connectedIndex >= 0;
      statuses.push({
        source: rawSource,
        connector,
        connected,
        connectUrl: connected ? null : connectUrlForConnector(connector),
      });
      continue;
    }
    const connector = connectorForSource(rawSource);
    if (connector === null) {
      statuses.push({ source: rawSource, connector: null, connected: true, connectUrl: null });
      continue;
    }
    // Calendar and Drive are connected when a Google account that granted them
    // is: one connected for email alone must be reconnected, and a failing email
    // sync (the shared `gmail` row's status) says nothing about these two.
    const connected =
      shared(rawSource) ||
      (needsGoogleWorkspaceGrant(rawSource)
        ? await hasGoogleWorkspaceAccount(userId)
        : await repo.isConnectorConnected(userId, connector));
    statuses.push({
      source: rawSource,
      connector,
      connected,
      connectUrl: connected ? null : connectUrlForConnector(connector),
    });
  }
  return statuses;
}

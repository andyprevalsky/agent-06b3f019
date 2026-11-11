/**
 * Data domain — per-source connectivity (the agent gate).
 *
 * For each requested data source, reports whether its backing connector is
 * CONNECTED and, when not, a URL the user can follow to connect it. Split from
 * service.ts for max-lines compliance.
 */

import { resolveTeamDataAccess } from '../../providers/teamAccess';
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
  granola: 'granola',
  granola_note: 'granola',
  granola_summary: 'granola',
  granola_transcript: 'granola',
};

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
  const grants = sources.some((source) => ['email', 'gmail', 'imessage'].includes(source))
    ? await resolveTeamDataAccess(userId)
    : [];
  const shared = (source: string) =>
    grants.some((grant) =>
      source === 'imessage'
        ? grant.provider === 'imessage' && grant.accountId === ''
        : ['email', 'gmail'].includes(source) &&
          grant.provider === 'gmail' &&
          Boolean(grant.accountEmail)
    );
  for (const rawSource of sources) {
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

import type { AdminHealthConnectorAdoption, AdminHealthConnectorSubtypeId } from './types';

export interface ConnectorRecord {
  userId: string;
  name: string;
}

const BROWSER_CONNECTORS = new Set([
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
  'safari',
]);

const EXACT_SUBTYPE_BY_CONNECTOR = new Map<string, AdminHealthConnectorSubtypeId>([
  ['claude_code', 'compute'],
  ['gpt_code', 'compute'],
  ['imessage', 'messages'],
  ['whatsapp', 'messages'],
  ['telegram', 'messages'],
  ['gmail', 'messages'],
  ['linkedin', 'socials'],
  ['twitter', 'socials'],
  ['x', 'socials'],
  ['instagram', 'socials'],
  ['plaid', 'financials'],
]);

const SUBTYPES: ReadonlyArray<{ id: AdminHealthConnectorSubtypeId; label: string }> = [
  { id: 'browsers', label: 'Browser Sync' },
  { id: 'passwords', label: 'Passwords' },
  { id: 'compute', label: 'Compute' },
  { id: 'messages', label: 'Messages' },
  { id: 'socials', label: 'Socials' },
  { id: 'financials', label: 'Financials' },
];

function connectorSubtype(name: string): AdminHealthConnectorSubtypeId | null {
  if (BROWSER_CONNECTORS.has(name)) return 'browsers';
  if (name.endsWith('_passwords') || name.endsWith('_passkeys')) return 'passwords';
  return EXACT_SUBTYPE_BY_CONNECTOR.get(name) ?? null;
}

/**
 * Count each eligible account at most once in each onboarding connector
 * category, regardless of how many providers they connected inside it.
 */
export function buildConnectorAdoption(
  eligibleUserIds: ReadonlySet<string>,
  connectors: ConnectorRecord[]
): AdminHealthConnectorAdoption {
  const usersBySubtype = new Map(SUBTYPES.map(({ id }) => [id, new Set<string>()] as const));
  for (const connector of connectors) {
    if (!eligibleUserIds.has(connector.userId)) continue;
    const subtype = connectorSubtype(connector.name);
    if (subtype !== null) usersBySubtype.get(subtype)?.add(connector.userId);
  }

  const eligibleUserCount = eligibleUserIds.size;
  return {
    eligibleUserCount,
    subtypes: SUBTYPES.map(({ id, label }) => {
      const connectedUsers = usersBySubtype.get(id)?.size ?? 0;
      return {
        id,
        label,
        connectedUsers,
        connectionRate:
          eligibleUserCount === 0 ? 0 : Number((connectedUsers / eligibleUserCount).toFixed(4)),
      };
    }),
  };
}

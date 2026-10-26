import { Prisma } from '@prisma/client';
import { prisma } from './database';

const DEFAULT_BASE_IMAGE = 'base:victoria-prod-sync-v1';
export const FIXTURE_TABLE_ORDER = [
  'User',
  'Tool',
  'Agent',
  'AgentTool',
  'Verifier',
  'Message',
  'ToolUsage',
  'PurchaseSpend',
  'AgentAttentionRequest',
  'UserAuthAssistanceRequest',
  'BrowserContext',
  'BrowserSession',
  'ClaudeCodeSession',
  'Person',
  'MessageRecord',
  'Integration',
  'EmailIntegrationCredential',
  'Cookie',
  'BrowserPassword',
  'CookieBundle',
  'SteelSessionAuth',
  'MintedAccount',
  'PasskeyCredential',
  'AgentIdentity',
  'AgentPhoneMessage',
  'AgentRunCredentialPropagation',
  'ToolSideEffect',
  'SmsSession',
  'SmsShortcode',
] as const;

type FixtureTable = (typeof FIXTURE_TABLE_ORDER)[number];
type JsonRows = Record<string, unknown[]>;
type FixtureDbClient = Prisma.TransactionClient;
type FixtureAgent = Prisma.AgentGetPayload<{
  select: { id: true; userId: true; goal: true; createdAt: true; status: true };
}>;
type ModelDelegate = {
  deleteMany(args: { where: Record<string, unknown> }): Promise<unknown>;
  createMany(args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }): Promise<unknown>;
};

export type ScopedDbFixture = {
  schema_version: 1;
  kind: 'scoped-db-fixture';
  phase: 'start' | 'end';
  captured_at: string;
  base_image: string;
  root_agent_id: string;
  user_id: string;
  agent_ids: string[];
  table_order: readonly FixtureTable[];
  restore: Record<string, unknown>;
  rows: JsonRows;
};

function asArray<T>(value: T | T[] | null): T[] {
  if (value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nowIso(): string {
  return new Date().toISOString();
}

function ids(rows: unknown[]): string[] {
  return rows
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string');
}

const AGENT_FIXTURE_SELECT = {
  id: true,
  userId: true,
  goal: true,
  createdAt: true,
  status: true,
} as const;

async function findRootAgent(db: FixtureDbClient, rootAgentId: string): Promise<FixtureAgent> {
  const root = await db.agent.findUnique({
    where: { id: rootAgentId },
    select: AGENT_FIXTURE_SELECT,
  });
  if (root === null) throw new Error(`Unknown root agent ${rootAgentId}`);
  return root;
}

async function agentTree(db: FixtureDbClient, root: FixtureAgent) {
  const agents = [root];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const children = await db.agent.findMany({
      where: { parentAgentId: { in: frontier } },
      select: AGENT_FIXTURE_SELECT,
    });
    frontier = [];
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      agents.push(child);
      frontier.push(child.id);
    }
  }
  return { agents, userId: root.userId };
}

export async function collectFixture(
  rootAgentId: string,
  phase: 'start' | 'end'
): Promise<ScopedDbFixture> {
  const root = await findRootAgent(prisma, rootAgentId);
  return collectFixtureWithClient(prisma, rootAgentId, phase, root);
}

/**
 * Start-fixture snapshot state machine / system context:
 *
 * Agent row committed
 *   -> BEGIN REPEATABLE READ
 *   -> root Agent SELECT anchors the PostgreSQL MVCC snapshot
 *   -> onSnapshotReady (the launch critical-path boundary)
 *   -> all remaining fixture reads use the same transaction client
 *   -> COMMIT with one point-in-time fixture
 *
 * Writes made after `onSnapshotReady` are intentionally absent even though the
 * remaining reads finish asynchronously after agent launch begins.
 */
export async function collectFixtureSnapshot(
  rootAgentId: string,
  phase: 'start' | 'end',
  onSnapshotReady: () => void | Promise<void>
): Promise<ScopedDbFixture> {
  return prisma.$transaction(
    async (tx) => {
      // PostgreSQL establishes a REPEATABLE READ snapshot on the first query,
      // not merely at BEGIN. Never move readiness above this SELECT.
      const root = await findRootAgent(tx, rootAgentId);
      await onSnapshotReady();
      return collectFixtureWithClient(tx, rootAgentId, phase, root);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 30_000,
    }
  );
}

async function collectFixtureWithClient(
  db: FixtureDbClient,
  rootAgentId: string,
  phase: 'start' | 'end',
  root: FixtureAgent
): Promise<ScopedDbFixture> {
  const tree = await agentTree(db, root);
  const agentIds = tree.agents.map((agent) => agent.id);
  const rows: JsonRows = {};

  const [
    user,
    agents,
    agentTools,
    verifiers,
    messages,
    toolUsages,
    purchaseSpends,
    attentionRequests,
    browserSessions,
    claudeCodeSessions,
    people,
    integrations,
    userEnvironmentRows,
    credentialPropagations,
    toolSideEffects,
    smsShortcodes,
  ] = await Promise.all([
    db.user.findUnique({ where: { userId: tree.userId } }),
    db.agent.findMany({ where: { id: { in: agentIds } } }),
    db.agentTool.findMany({ where: { agentId: { in: agentIds } } }),
    db.verifier.findMany({ where: { agentId: { in: agentIds } } }),
    db.message.findMany({
      where: { agentId: { in: agentIds } },
      orderBy: { timestamp: 'asc' },
    }),
    db.toolUsage.findMany({ where: { agentId: { in: agentIds } } }),
    db.purchaseSpend.findMany({
      where: { agentId: { in: agentIds } },
    }),
    db.agentAttentionRequest.findMany({
      where: { agentId: { in: agentIds } },
    }),
    db.browserSession.findMany({
      where: { agentId: { in: agentIds } },
    }),
    db.claudeCodeSession.findMany({
      where: { agentId: { in: agentIds } },
    }),
    db.person.findMany({ where: { userId: tree.userId } }),
    db.integration.findMany({ where: { userId: tree.userId } }),
    collectUserEnvironmentRows(db, tree.userId),
    db.agentRunCredentialPropagation.findMany({
      where: { agentId: { in: agentIds } },
    }),
    db.toolSideEffect.findMany({
      where: { OR: agentIds.map((id) => ({ operationKey: { contains: id } })) },
    }),
    db.smsShortcode.findMany({ where: { agentId: { in: agentIds } } }),
  ]);

  rows.User = asArray(user);
  rows.Agent = agents;
  rows.AgentTool = agentTools;
  rows.Verifier = verifiers;
  rows.Message = messages;
  rows.ToolUsage = toolUsages;
  rows.PurchaseSpend = purchaseSpends;
  rows.AgentAttentionRequest = attentionRequests;
  rows.BrowserSession = browserSessions;
  rows.ClaudeCodeSession = claudeCodeSessions;
  rows.Person = people;
  rows.Integration = integrations;
  Object.assign(rows, userEnvironmentRows);
  rows.AgentRunCredentialPropagation = credentialPropagations;
  rows.ToolSideEffect = toolSideEffects;
  rows.SmsShortcode = smsShortcodes;

  const toolIds = rows.AgentTool.map((row) => (row as { toolId?: string }).toolId).filter(
    (id): id is string => typeof id === 'string'
  );
  const attentionIds = ids(rows.AgentAttentionRequest);
  const contextIds = rows.BrowserSession.map(
    (row) => (row as { contextId?: string }).contextId
  ).filter((id): id is string => typeof id === 'string');
  const personIds = ids(rows.Person);
  const integrationIds = ids(rows.Integration);

  const [tools, userAuthAssistanceRequests, browserContexts, messageRecords, emailCredentials] =
    await Promise.all([
      toolIds.length > 0 ? db.tool.findMany({ where: { id: { in: toolIds } } }) : [],
      attentionIds.length > 0
        ? db.userAuthAssistanceRequest.findMany({ where: { id: { in: attentionIds } } })
        : [],
      contextIds.length > 0
        ? db.browserContext.findMany({ where: { id: { in: contextIds } } })
        : [],
      personIds.length > 0
        ? db.messageRecord.findMany({ where: { personId: { in: personIds } } })
        : [],
      integrationIds.length > 0
        ? db.emailIntegrationCredential.findMany({
            where: { integrationId: { in: integrationIds } },
          })
        : [],
    ]);

  rows.Tool = tools;
  rows.UserAuthAssistanceRequest = userAuthAssistanceRequests;
  rows.BrowserContext = browserContexts;
  rows.MessageRecord = messageRecords;
  rows.EmailIntegrationCredential = emailCredentials;
  return buildFixture(rootAgentId, phase, tree.userId, agentIds, rows);
}

async function collectUserEnvironmentRows(db: FixtureDbClient, userId: string): Promise<JsonRows> {
  const [
    cookies,
    browserPasswords,
    cookieBundles,
    steelSessionAuths,
    mintedAccounts,
    passkeyCredentials,
    agentIdentity,
    agentPhoneMessages,
    smsSession,
  ] = await Promise.all([
    db.cookie.findMany({ where: { userId } }),
    db.browserPassword.findMany({ where: { userId } }),
    db.cookieBundle.findMany({ where: { userId } }),
    db.steelSessionAuth.findMany({ where: { userId } }),
    db.mintedAccount.findMany({ where: { userId } }),
    db.passkeyCredential.findMany({ where: { userId } }),
    db.agentIdentity.findUnique({ where: { userId } }),
    db.agentPhoneMessage.findMany({ where: { userId } }),
    db.smsSession.findUnique({ where: { userId } }),
  ]);

  return {
    Cookie: cookies,
    BrowserPassword: browserPasswords,
    CookieBundle: cookieBundles,
    SteelSessionAuth: steelSessionAuths,
    MintedAccount: mintedAccounts,
    PasskeyCredential: passkeyCredentials,
    AgentIdentity: asArray(agentIdentity),
    AgentPhoneMessage: agentPhoneMessages,
    SmsSession: asArray(smsSession),
  };
}

function buildFixture(
  rootAgentId: string,
  phase: 'start' | 'end',
  userId: string,
  agentIds: string[],
  rows: JsonRows
): ScopedDbFixture {
  return {
    schema_version: 1,
    kind: 'scoped-db-fixture',
    phase,
    captured_at: nowIso(),
    base_image: DEFAULT_BASE_IMAGE,
    root_agent_id: rootAgentId,
    user_id: userId,
    agent_ids: agentIds,
    table_order: FIXTURE_TABLE_ORDER,
    restore: {
      strategy: 'delete-scoped-rows-then-insert-in-table-order',
      scope: { root_agent_id: rootAgentId, user_id: userId, agent_ids: agentIds },
    },
    rows,
  };
}

export async function restoreFixture(fixture: ScopedDbFixture): Promise<void> {
  await deleteFixtureScope(fixture);
  for (const table of fixture.table_order) {
    const tableRows = (fixture.rows[table] ?? []).map((row) =>
      normalizeRow(table, row, fixture.user_id)
    );
    if (tableRows.length === 0) continue;
    await delegate(table).createMany({ data: tableRows, skipDuplicates: table === 'Tool' });
  }
}

async function deleteFixtureScope(fixture: ScopedDbFixture): Promise<void> {
  for (const table of [...fixture.table_order].reverse()) {
    if (table === 'Tool') continue;
    const where = deleteWhere(table, fixture);
    if (where !== null) await delegate(table).deleteMany({ where });
  }
}

function deleteWhere(
  table: FixtureTable,
  fixture: ScopedDbFixture
): Record<string, unknown> | null {
  const agentScope = { in: fixture.agent_ids };
  if (
    [
      'Agent',
      'AgentTool',
      'Verifier',
      'Message',
      'ToolUsage',
      'PurchaseSpend',
      'AgentAttentionRequest',
      'BrowserSession',
      'ClaudeCodeSession',
      'AgentRunCredentialPropagation',
      'SmsShortcode',
    ].includes(table)
  ) {
    return { [table === 'Agent' ? 'id' : 'agentId']: agentScope };
  }
  if (
    [
      'User',
      'Person',
      'Integration',
      'Cookie',
      'BrowserPassword',
      'CookieBundle',
      'SteelSessionAuth',
      'MintedAccount',
      'PasskeyCredential',
      'AgentIdentity',
      'AgentPhoneMessage',
      'SmsSession',
    ].includes(table)
  ) {
    return { userId: fixture.user_id };
  }
  if (table === 'MessageRecord') return { personId: { in: ids(fixture.rows.Person ?? []) } };
  if (table === 'EmailIntegrationCredential')
    return { integrationId: { in: ids(fixture.rows.Integration ?? []) } };
  if (table === 'UserAuthAssistanceRequest')
    return { id: { in: ids(fixture.rows.AgentAttentionRequest ?? []) } };
  if (table === 'BrowserContext') return { id: { in: ids(fixture.rows.BrowserContext ?? []) } };
  if (table === 'ToolSideEffect') return { id: { in: ids(fixture.rows.ToolSideEffect ?? []) } };
  return null;
}

function delegate(table: FixtureTable): ModelDelegate {
  const name = table.charAt(0).toLowerCase() + table.slice(1);
  return (prisma as unknown as Record<string, ModelDelegate>)[name];
}

function normalizeRow(table: FixtureTable, row: unknown, userId: string): Record<string, unknown> {
  const normalized = { ...(row as Record<string, unknown>) };
  // Fixtures archived before MessageRecord.userId existed omit it; every
  // captured Person, and so every message, belongs to the fixture's user.
  if (table === 'MessageRecord' && normalized.userId === undefined) normalized.userId = userId;
  for (const field of BIGINT_FIELDS[table] ?? []) {
    const value = normalized[field];
    if (typeof value === 'string' || typeof value === 'number') normalized[field] = BigInt(value);
  }
  return normalized;
}

const BIGINT_FIELDS: Partial<Record<FixtureTable, string[]>> = {
  Cookie: ['expiresUtc', 'creationUtc', 'lastAccessUtc', 'lastUpdateUtc'],
  BrowserPassword: ['dateLastUsed', 'dateCreated'],
  PasskeyCredential: ['signCount'],
};

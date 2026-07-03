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

async function agentTree(rootAgentId: string) {
  const root = await prisma.agent.findUnique({
    where: { id: rootAgentId },
    select: { id: true, userId: true, goal: true, createdAt: true, status: true },
  });
  if (root === null) throw new Error(`Unknown root agent ${rootAgentId}`);
  const agents = [root];
  const seen = new Set([root.id]);
  let frontier = [root.id];
  while (frontier.length > 0) {
    const children = await prisma.agent.findMany({
      where: { parentAgentId: { in: frontier } },
      select: { id: true, userId: true, goal: true, createdAt: true, status: true },
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
  const tree = await agentTree(rootAgentId);
  const agentIds = tree.agents.map((agent) => agent.id);
  const rows: JsonRows = {};
  rows.User = asArray(await prisma.user.findUnique({ where: { userId: tree.userId } }));
  rows.Agent = await prisma.agent.findMany({ where: { id: { in: agentIds } } });
  rows.AgentTool = await prisma.agentTool.findMany({ where: { agentId: { in: agentIds } } });
  const toolIds = rows.AgentTool.map((row) => (row as { toolId?: string }).toolId).filter(
    (id): id is string => typeof id === 'string'
  );
  rows.Tool =
    toolIds.length > 0 ? await prisma.tool.findMany({ where: { id: { in: toolIds } } }) : [];
  rows.Verifier = await prisma.verifier.findMany({ where: { agentId: { in: agentIds } } });
  rows.Message = await prisma.message.findMany({
    where: { agentId: { in: agentIds } },
    orderBy: { timestamp: 'asc' },
  });
  rows.ToolUsage = await prisma.toolUsage.findMany({ where: { agentId: { in: agentIds } } });
  rows.PurchaseSpend = await prisma.purchaseSpend.findMany({
    where: { agentId: { in: agentIds } },
  });
  rows.AgentAttentionRequest = await prisma.agentAttentionRequest.findMany({
    where: { agentId: { in: agentIds } },
  });
  const attentionIds = ids(rows.AgentAttentionRequest);
  rows.UserAuthAssistanceRequest =
    attentionIds.length > 0
      ? await prisma.userAuthAssistanceRequest.findMany({ where: { id: { in: attentionIds } } })
      : [];
  rows.BrowserSession = await prisma.browserSession.findMany({
    where: { agentId: { in: agentIds } },
  });
  const contextIds = rows.BrowserSession.map(
    (row) => (row as { contextId?: string }).contextId
  ).filter((id): id is string => typeof id === 'string');
  rows.BrowserContext =
    contextIds.length > 0
      ? await prisma.browserContext.findMany({ where: { id: { in: contextIds } } })
      : [];
  rows.ClaudeCodeSession = await prisma.claudeCodeSession.findMany({
    where: { agentId: { in: agentIds } },
  });
  rows.Person = await prisma.person.findMany({ where: { userId: tree.userId } });
  const personIds = ids(rows.Person);
  rows.MessageRecord =
    personIds.length > 0
      ? await prisma.messageRecord.findMany({ where: { personId: { in: personIds } } })
      : [];
  rows.Integration = await prisma.integration.findMany({ where: { userId: tree.userId } });
  const integrationIds = ids(rows.Integration);
  rows.EmailIntegrationCredential =
    integrationIds.length > 0
      ? await prisma.emailIntegrationCredential.findMany({
          where: { integrationId: { in: integrationIds } },
        })
      : [];
  await collectUserEnvironmentRows(rows, tree.userId);
  rows.AgentRunCredentialPropagation = await prisma.agentRunCredentialPropagation.findMany({
    where: { agentId: { in: agentIds } },
  });
  rows.ToolSideEffect = await prisma.toolSideEffect.findMany({
    where: { OR: agentIds.map((id) => ({ operationKey: { contains: id } })) },
  });
  rows.SmsShortcode = await prisma.smsShortcode.findMany({ where: { agentId: { in: agentIds } } });
  return buildFixture(rootAgentId, phase, tree.userId, agentIds, rows);
}

async function collectUserEnvironmentRows(rows: JsonRows, userId: string): Promise<void> {
  rows.Cookie = await prisma.cookie.findMany({ where: { userId } });
  rows.BrowserPassword = await prisma.browserPassword.findMany({ where: { userId } });
  rows.CookieBundle = await prisma.cookieBundle.findMany({ where: { userId } });
  rows.SteelSessionAuth = await prisma.steelSessionAuth.findMany({ where: { userId } });
  rows.MintedAccount = await prisma.mintedAccount.findMany({ where: { userId } });
  rows.PasskeyCredential = await prisma.passkeyCredential.findMany({ where: { userId } });
  rows.AgentIdentity = asArray(await prisma.agentIdentity.findUnique({ where: { userId } }));
  rows.AgentPhoneMessage = await prisma.agentPhoneMessage.findMany({ where: { userId } });
  rows.SmsSession = asArray(await prisma.smsSession.findUnique({ where: { userId } }));
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
    const tableRows = (fixture.rows[table] ?? []).map((row) => normalizeRow(table, row));
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

function normalizeRow(table: FixtureTable, row: unknown): Record<string, unknown> {
  const normalized = { ...(row as Record<string, unknown>) };
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

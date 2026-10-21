import { CHAT_ONLY_TOOL_NAMES } from '../../providers/realAgentRuns';
import type { RootAgentRunUsageRecord } from './types';

export { CHAT_ONLY_TOOL_NAMES };

const CHAT_ONLY_TOOL_NAME_SET = new Set<string>(CHAT_ONLY_TOOL_NAMES);

export interface CostTelemetrySourceRow {
  agentId: string | null;
  toolName: string;
  usageItems: unknown;
}

export interface StoredRootCostTelemetry {
  schemaVersion: 1;
  usage: Array<Omit<RootAgentRunUsageRecord, 'taskId'>>;
}

export interface ArchivedRootCostTelemetry {
  worldModelMode: string;
  telemetry: StoredRootCostTelemetry | null;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function groupingKey(row: Omit<RootAgentRunUsageRecord, 'taskId'>): string {
  return JSON.stringify([row.kind, row.model, row.fromFastCache]);
}

export function isAgentLoopTool(toolName: string): boolean {
  return !CHAT_ONLY_TOOL_NAME_SET.has(toolName);
}

export function buildStoredRootCostTelemetry(
  rows: CostTelemetrySourceRow[]
): StoredRootCostTelemetry | null {
  if (!rows.some((row) => isAgentLoopTool(row.toolName))) return null;
  const usage = new Map<string, Omit<RootAgentRunUsageRecord, 'taskId'>>();
  for (const row of rows) {
    if (!Array.isArray(row.usageItems)) continue;
    for (const item of row.usageItems) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const next = {
        kind: stringValue(value.type, 'unknown'),
        // Do not invent a billable model for model-less chat rows in archived
        // telemetry — cutover-aware pricing belongs in live SQL (costRepo).
        model: stringValue(value.model, 'unknown'),
        fromFastCache: value.from_fast_cache === true,
        tokensIn: finiteNumber(value.tokens_in),
        cacheReadInputTokens: finiteNumber(value.cache_read_input_tokens),
        cacheCreationInputTokens: finiteNumber(value.cache_creation_input_tokens),
        tokensOut: finiteNumber(value.tokens_out),
        costCents: finiteNumber(value.cost_cents),
      };
      const key = groupingKey(next);
      const current = usage.get(key);
      if (current === undefined) {
        usage.set(key, next);
      } else {
        current.tokensIn += next.tokensIn;
        current.cacheReadInputTokens += next.cacheReadInputTokens;
        current.cacheCreationInputTokens += next.cacheCreationInputTokens;
        current.tokensOut += next.tokensOut;
        current.costCents += next.costCents;
      }
    }
  }
  return { schemaVersion: 1, usage: [...usage.values()] };
}

function isStoredUsage(value: unknown): value is Omit<RootAgentRunUsageRecord, 'taskId'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.kind === 'string' &&
    typeof row.model === 'string' &&
    typeof row.fromFastCache === 'boolean' &&
    typeof row.tokensIn === 'number' &&
    typeof row.cacheReadInputTokens === 'number' &&
    typeof row.cacheCreationInputTokens === 'number' &&
    typeof row.tokensOut === 'number' &&
    typeof row.costCents === 'number'
  );
}

export function readStoredRootCostTelemetry(
  taskId: string,
  value: unknown
): RootAgentRunUsageRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const telemetry = value as Record<string, unknown>;
  if (telemetry.schemaVersion !== 1 || !Array.isArray(telemetry.usage)) return [];
  return telemetry.usage.filter(isStoredUsage).map((usage) => ({ taskId, ...usage }));
}

export function buildArchivedRootCostTelemetry(
  rootAgentId: string,
  fixture: unknown
): ArchivedRootCostTelemetry | null {
  if (typeof fixture !== 'object' || fixture === null || Array.isArray(fixture)) return null;
  const rows = (fixture as Record<string, unknown>).rows;
  if (typeof rows !== 'object' || rows === null || Array.isArray(rows)) return null;
  const tables = rows as Record<string, unknown>;
  const agents = Array.isArray(tables.Agent) ? tables.Agent : [];
  const root = agents.find(
    (agent) =>
      typeof agent === 'object' &&
      agent !== null &&
      !Array.isArray(agent) &&
      (agent as Record<string, unknown>).id === rootAgentId
  );
  if (root === undefined) return null;
  const worldModelMode = stringValue((root as Record<string, unknown>).worldModelMode, 'real');
  const toolUsages = Array.isArray(tables.ToolUsage) ? tables.ToolUsage : [];
  const rootRows = toolUsages.flatMap((usage): CostTelemetrySourceRow[] => {
    if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return [];
    const row = usage as Record<string, unknown>;
    if (row.agentId !== rootAgentId || typeof row.toolName !== 'string') return [];
    return [{ agentId: rootAgentId, toolName: row.toolName, usageItems: row.usageItems }];
  });
  return {
    worldModelMode,
    telemetry: buildStoredRootCostTelemetry(rootRows),
  };
}

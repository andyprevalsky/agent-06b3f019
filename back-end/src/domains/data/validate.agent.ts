/** Parse agent-specific grep selectors. */
import { InvalidGrepParamError } from './errors';
import { agentTaskPathParam, parseGrepPath } from './path';
import type {
  AgentNetworkGrepFilters,
  AgentTrajectoryGrepFilters,
  GrepParams,
  ValidatedGrepInput,
} from './types';
import {
  parseFilterDate,
  parseFilterSince,
  parseFilterString,
  printedPathHint,
  type FilterObject,
} from './validate.filters';

const ROLE_HINT = 'Use USER, ASSISTANT or TOOL.';

export const PAGE_AFTER_HINT =
  "Pass the previous agent_trajectories result's next_page_after unchanged, with the same query and order.";

export function parseAgentPaging(
  params: GrepParams
): Pick<ValidatedGrepInput, 'order' | 'pageAfterMessageId' | 'pageAfterPath'> {
  if (params.order !== undefined && !['newest_first', 'oldest_first'].includes(params.order)) {
    throw new InvalidGrepParamError('order', 'Use newest_first or oldest_first.');
  }
  const pageAfter = params.page_after === undefined ? undefined : parseGrepPath(params.page_after);
  if (
    params.page_after !== undefined &&
    (pageAfter?.source !== 'agent_trajectories' ||
      pageAfter.messageId === undefined ||
      pageAfter.role === undefined ||
      pageAfter.rootAgentId === undefined)
  ) {
    throw new InvalidGrepParamError('page_after', PAGE_AFTER_HINT);
  }
  if (
    params.page_after !== undefined &&
    params.offset !== undefined &&
    Number(params.offset) !== 0
  ) {
    throw new InvalidGrepParamError('offset', 'page_after replaces offset; remove offset.');
  }
  return {
    order: params.order ?? 'newest_first',
    pageAfterMessageId:
      pageAfter?.source === 'agent_trajectories' ? pageAfter.messageId : undefined,
    pageAfterPath: params.page_after?.trim().replace(/\/+$/, ''),
  };
}

/** An agent address in filters.path scopes like trace_path; both must agree. */
function agentNetworkTaskPath(params: GrepParams, rawPath: string | undefined): string | undefined {
  const fromParam = agentTaskPathParam(params.trace_path);
  const fromFilter = agentTaskPathParam(rawPath);
  if (fromParam !== undefined && fromFilter !== undefined && fromParam !== fromFilter) {
    throw new InvalidGrepParamError(
      'filters.path',
      'It names a different agent than trace_path; give the agent address once.'
    );
  }
  return fromParam ?? fromFilter;
}

export function parseAgentNetworkFilters(
  params: GrepParams,
  filters: FilterObject
): AgentNetworkGrepFilters | undefined {
  const raw = { ...filters };
  if (params.role !== undefined) {
    if (
      raw.role !== undefined &&
      String(raw.role).toUpperCase() !== String(params.role).toUpperCase()
    ) {
      throw new InvalidGrepParamError('role', 'It differs from filters.role; give the role once.');
    }
    raw.role = params.role;
  }
  const rawPath = parseFilterString(raw, 'path');
  const taskPath = agentNetworkTaskPath(params, rawPath);
  const recordPath = agentTaskPathParam(rawPath) === undefined ? rawPath : undefined;
  if (recordPath === undefined && raw.role === undefined) {
    return taskPath === undefined ? undefined : { taskPath };
  }
  const parsed = recordPath === undefined ? undefined : parseGrepPath(recordPath);
  if (recordPath !== undefined && (parsed === null || parsed?.source !== 'agent_network')) {
    throw new InvalidGrepParamError('filters.path', printedPathHint('agent_network'));
  }
  const role = parseFilterString(raw, 'role')?.toUpperCase();
  if (role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(role)) {
    throw new InvalidGrepParamError('role', ROLE_HINT);
  }
  const path = parsed?.source === 'agent_network' ? parsed : undefined;
  if (path?.role === 'SYSTEM') {
    throw new InvalidGrepParamError('filters.path', 'System prompts are not searchable.');
  }
  return {
    taskPath,
    pathAgentId: path?.agentId,
    pathRole: path?.role,
    pathMessageId: path?.messageId,
    role,
  };
}

export function parseAgentTrajectoryFilters(
  params: GrepParams,
  filters: FilterObject
): AgentTrajectoryGrepFilters | undefined {
  const raw = { ...filters };
  // since/until arrive through `filters` already (validate.normalize.ts).
  const direct: Record<string, unknown> = {
    role: params.role,
    record_kind: params.record_kind,
    surface: params.surface,
    trace_path: params.trace_path,
  };
  for (const [param, value] of Object.entries(direct)) {
    if (value === undefined) continue;
    const key = param === 'trace_path' ? 'path' : param;
    if (raw[key] !== undefined && String(raw[key]).toLowerCase() !== String(value).toLowerCase()) {
      throw new InvalidGrepParamError(param, `It differs from filters.${key}; give it once.`);
    }
    raw[key] = value;
  }
  if (Object.keys(raw).length === 0) return undefined;
  const rawPath = parseFilterString(raw, 'path');
  const taskPath = agentTaskPathParam(rawPath);
  const parsed =
    rawPath === undefined || taskPath !== undefined
      ? undefined
      : parseGrepPath(
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(rawPath)
            ? `agent_trajectories/${rawPath}`
            : rawPath
        );
  if (rawPath !== undefined && taskPath === undefined && parsed?.source !== 'agent_trajectories') {
    const param = params.trace_path === undefined ? 'filters.path' : 'trace_path';
    throw new InvalidGrepParamError(param, printedPathHint('agent_trajectories'));
  }
  const path = parsed?.source === 'agent_trajectories' ? parsed : undefined;
  const role = parseFilterString(raw, 'role')?.toUpperCase();
  const surface = parseFilterString(raw, 'surface')?.toUpperCase();
  const recordKind = parseFilterString(raw, 'record_kind')?.toLowerCase();
  if (role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(role)) {
    throw new InvalidGrepParamError(params.role === undefined ? 'filters.role' : 'role', ROLE_HINT);
  }
  if (path?.role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(path.role)) {
    throw new InvalidGrepParamError('filters.path', 'System prompts are not searchable.');
  }
  if (surface !== undefined && !['WEB', 'MAC_APP', 'SMS', 'WHATSAPP'].includes(surface)) {
    throw new InvalidGrepParamError(
      params.surface === undefined ? 'filters.surface' : 'surface',
      'Use WEB, MAC_APP, SMS or WHATSAPP.'
    );
  }
  if (
    recordKind !== undefined &&
    !['all', 'message', 'llm_output', 'llm_context', 'code_event'].includes(recordKind)
  ) {
    throw new InvalidGrepParamError(
      params.record_kind === undefined ? 'filters.record_kind' : 'record_kind',
      'Use message, llm_output, llm_context or all.'
    );
  }
  return {
    taskPath,
    pathRootAgentId: path?.rootAgentId,
    pathAgentId: path?.agentId,
    pathRole: path?.role,
    pathMessageId: path?.messageId,
    since: parseFilterSince(raw, 'since'),
    until: parseFilterDate(raw, 'until'),
    role: role as AgentTrajectoryGrepFilters['role'],
    surface: surface as AgentTrajectoryGrepFilters['surface'],
    recordKind: recordKind as AgentTrajectoryGrepFilters['recordKind'],
  };
}

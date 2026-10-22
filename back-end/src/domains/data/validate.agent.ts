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
  rejectUnsupportedFilters,
  requireFilterObject,
} from './validate.filters';

export function parseAgentPaging(
  params: GrepParams
): Pick<ValidatedGrepInput, 'order' | 'pageAfterMessageId' | 'pageAfterPath'> {
  if (params.order !== undefined && !['newest_first', 'oldest_first'].includes(params.order)) {
    throw new InvalidGrepParamError('order');
  }
  const pageAfter = params.page_after === undefined ? undefined : parseGrepPath(params.page_after);
  if (
    params.page_after !== undefined &&
    (pageAfter?.source !== 'agent_trajectories' ||
      pageAfter.messageId === undefined ||
      pageAfter.role === undefined ||
      pageAfter.rootAgentId === undefined)
  ) {
    throw new InvalidGrepParamError('page_after');
  }
  if (
    params.page_after !== undefined &&
    params.offset !== undefined &&
    Number(params.offset) !== 0
  ) {
    throw new InvalidGrepParamError('page_after with offset');
  }
  return {
    order: params.order ?? 'newest_first',
    pageAfterMessageId:
      pageAfter?.source === 'agent_trajectories' ? pageAfter.messageId : undefined,
    pageAfterPath: params.page_after?.trim().replace(/\/+$/, ''),
  };
}

export function parseAgentNetworkFilters(params: GrepParams): AgentNetworkGrepFilters | undefined {
  const raw = { ...requireFilterObject(params) };
  const taskPath = agentTaskPathParam(params.trace_path);
  if (params.role !== undefined) {
    if (
      raw.role !== undefined &&
      String(raw.role).toUpperCase() !== String(params.role).toUpperCase()
    ) {
      throw new InvalidGrepParamError('role');
    }
    raw.role = params.role;
  }
  if (Object.keys(raw).length === 0) return taskPath === undefined ? undefined : { taskPath };
  rejectUnsupportedFilters('agent_network', raw);
  const rawPath = parseFilterString(raw, 'path');
  const parsed = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  if (rawPath !== undefined && (parsed === null || parsed?.source !== 'agent_network')) {
    throw new InvalidGrepParamError('filters.path');
  }
  const role = parseFilterString(raw, 'role')?.toUpperCase();
  if (role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(role)) {
    throw new InvalidGrepParamError('role');
  }
  const path = parsed?.source === 'agent_network' ? parsed : undefined;
  if (path?.role === 'SYSTEM') throw new InvalidGrepParamError('filters.path');
  return {
    taskPath,
    pathAgentId: path?.agentId,
    pathRole: path?.role,
    pathMessageId: path?.messageId,
    role,
  };
}

export function parseAgentTrajectoryFilters(
  params: GrepParams
): AgentTrajectoryGrepFilters | undefined {
  const raw = { ...requireFilterObject(params) };
  const direct: Record<string, unknown> = {
    role: params.role,
    record_kind: params.record_kind,
    surface: params.surface,
    path: params.trace_path,
    since: params.since,
    until: params.until,
  };
  for (const [key, value] of Object.entries(direct)) {
    if (value === undefined) continue;
    if (raw[key] !== undefined && String(raw[key]).toLowerCase() !== String(value).toLowerCase()) {
      throw new InvalidGrepParamError(key);
    }
    raw[key] = value;
  }
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('agent_trajectories', raw);
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
    throw new InvalidGrepParamError('filters.path');
  }
  const path = parsed?.source === 'agent_trajectories' ? parsed : undefined;
  const role = parseFilterString(raw, 'role')?.toUpperCase();
  const surface = parseFilterString(raw, 'surface')?.toUpperCase();
  const recordKind = parseFilterString(raw, 'record_kind')?.toLowerCase();
  if (role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(role)) {
    throw new InvalidGrepParamError('filters.role');
  }
  if (path?.role !== undefined && !['USER', 'ASSISTANT', 'TOOL'].includes(path.role)) {
    throw new InvalidGrepParamError('filters.path');
  }
  if (surface !== undefined && !['WEB', 'MAC_APP', 'SMS', 'WHATSAPP'].includes(surface)) {
    throw new InvalidGrepParamError('filters.surface');
  }
  if (
    recordKind !== undefined &&
    !['all', 'message', 'llm_output', 'llm_context'].includes(recordKind)
  ) {
    throw new InvalidGrepParamError('filters.record_kind');
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

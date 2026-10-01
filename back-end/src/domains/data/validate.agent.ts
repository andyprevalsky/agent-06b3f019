/** Parse agent-specific grep selectors. */
import { InvalidGrepParamError } from './errors';
import { parseGrepPath } from './path';
import type { AgentNetworkGrepFilters, AgentTrajectoryGrepFilters, GrepParams } from './types';
import {
  parseFilterDate,
  parseFilterSince,
  parseFilterString,
  rejectUnsupportedFilters,
  requireFilterObject,
} from './validate.filters';

export function parseAgentNetworkFilters(params: GrepParams): AgentNetworkGrepFilters | undefined {
  const raw = { ...requireFilterObject(params) };
  if (params.role !== undefined) {
    if (
      raw.role !== undefined &&
      String(raw.role).toUpperCase() !== String(params.role).toUpperCase()
    ) {
      throw new InvalidGrepParamError('role');
    }
    raw.role = params.role;
  }
  if (Object.keys(raw).length === 0) return undefined;
  rejectUnsupportedFilters('agent_network', raw);
  const rawPath = parseFilterString(raw, 'path');
  const parsed = rawPath === undefined ? undefined : parseGrepPath(rawPath);
  if (rawPath !== undefined && (parsed === null || parsed?.source !== 'agent_network')) {
    throw new InvalidGrepParamError('filters.path');
  }
  const role = parseFilterString(raw, 'role')?.toUpperCase();
  if (role !== undefined && !['USER', 'ASSISTANT', 'TOOL', 'SYSTEM'].includes(role)) {
    throw new InvalidGrepParamError('role');
  }
  const path = parsed?.source === 'agent_network' ? parsed : undefined;
  return {
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
  const parsed =
    rawPath === undefined
      ? undefined
      : parseGrepPath(
          /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(rawPath)
            ? `agent_trajectories/${rawPath}`
            : rawPath
        );
  if (rawPath !== undefined && parsed?.source !== 'agent_trajectories') {
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

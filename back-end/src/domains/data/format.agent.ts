import type { AgentTrajectoryRow } from './trajectoryRepo';
import type { GrepMatch, ValidatedGrepInput } from './types';
import { buildAgentTrajectoryPath } from './path';
import { formatSnippet } from './format.snippets';

export function buildAgentTrajectoryMatch(
  row: AgentTrajectoryRow,
  input: ValidatedGrepInput
): GrepMatch {
  const path = buildAgentTrajectoryPath(row.rootAgentId, row.agentId, row.role, row.messageId);
  const toolStatus = /^(?:\*\*Goal\*\*:[\s\S]*?\n\n)?\*\*Status\*\*:[^\S\n]*(.+)/i.exec(
    row.searchText
  )?.[1];
  const agentPath = row.agentPath;
  const heading = [
    `trace_path: ${path}`,
    ...(agentPath !== null ? [`agent_path: ${agentPath}`] : []),
    `message_role: ${row.role}`,
    `agent_title: ${row.agentTitle !== null && row.agentTitle !== '' ? row.agentTitle : row.agentGoal}`,
    `record_kind: ${row.traceKind}`,
    ...(row.role === 'TOOL' && toolStatus !== undefined ? [`tool_status: ${toolStatus}`] : []),
    ...(row.archivePath !== null ? [`archive: ${row.archivePath}`] : []),
  ].join('\n');
  const snippet = formatSnippet(
    row.searchText,
    input.regex,
    input.contextBefore,
    input.contextAfter,
    input.showLineNumbers
  );
  return {
    source: 'agent_trajectories',
    path,
    pointer:
      row.archivePath !== null
        ? `@ref:trace-archive:${row.rootAgentId}/${row.archivePath}`
        : `@ref:message:${row.messageId}`,
    timestamp: row.createdAt.toISOString(),
    role: row.role,
    location: {
      source: 'agent_trajectories',
      path,
      root_agent_id: row.rootAgentId,
      agent_id: row.agentId,
      ...(agentPath !== null ? { agent_path: agentPath } : {}),
      message_id: row.messageId,
      role: row.role,
      surface: row.surface,
      field: row.traceKind,
      ...(row.archivePath !== null ? { archive_path: row.archivePath } : {}),
    },
    content: `${heading}\n${snippet}`,
  };
}

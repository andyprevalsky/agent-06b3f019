/** Account coordination is explicit; existing tree endpoints keep their narrower scope. */
import {
  ACCOUNT_LIST_DEFAULT,
  ACCOUNT_READ_DEFAULT,
  ACCOUNT_PAGE_BYTES,
  pageLimit,
  queryIdentity,
  decodeAccountCursor,
  encodeAccountCursor,
  responseBytes,
} from '../../providers/agentGraph/pagination';
import { AgentGraphError, type GraphCaller } from './agentGraphService';
import * as repo from './repoAgentAccount';

export function requireAccountAccess(caller: GraphCaller): void {
  if (caller.accountAccess !== true)
    throw new AgentGraphError(403, 'This session has no account-agent access');
}

export interface AccountQuery {
  project?: string;
  folder?: string;
  cursor?: string;
  limit?: number;
}

function cursorFor(query: unknown, raw?: string) {
  try {
    return decodeAccountCursor(raw, queryIdentity(query));
  } catch (err) {
    throw new AgentGraphError(400, (err as Error).message);
  }
}
function limitFor(value: unknown, fallback: number) {
  try {
    return pageLimit(value, fallback);
  } catch (err) {
    throw new AgentGraphError(400, (err as Error).message);
  }
}

export async function listAccountAgents(caller: GraphCaller, query: AccountQuery) {
  requireAccountAccess(caller);
  const limit = limitFor(query.limit, ACCOUNT_LIST_DEFAULT);
  const cursor = cursorFor(
    [caller.userId, query.project ?? null, query.folder ?? null],
    query.cursor
  );
  const rows = await repo.accountAgentPage(
    caller.userId,
    query.project,
    query.folder,
    cursor,
    limit
  );
  const agents = rows.slice(0, limit).map((r) => ({
    agent_id: r.id,
    title: r.title,
    goal_preview: r.goal,
    status: r.status,
    project_id: r.projectId,
    folder_id: r.folderId,
    created_at: r.createdAt.toISOString(),
    read_command: `rose-agents read ${r.id} --json`,
  }));
  while (agents.length > 1 && responseBytes({ agents }) > ACCOUNT_PAGE_BYTES - 4096) agents.pop();
  const last = agents.at(-1);
  const next =
    rows.length > agents.length && last !== undefined
      ? encodeAccountCursor({ ...cursor, at: last.created_at, id: last.agent_id })
      : null;
  const result = {
    agents,
    has_more: next !== null,
    next_cursor: next,
    next_command:
      next === null
        ? null
        : `rose-agents list --scope account${query.project === undefined ? '' : ` --project ${query.project}`}${query.folder === undefined ? '' : ` --folder ${query.folder}`} --limit ${limit} --cursor ${next} --json`,
    previews: true,
    snapshot: cursor.snapshot,
  };
  if (responseBytes(result) > ACCOUNT_PAGE_BYTES)
    throw new AgentGraphError(413, 'Page too large; request a smaller limit');
  return result;
}

export async function readAccountAgent(
  caller: GraphCaller,
  id: string,
  query: { cursor?: string; limit?: number; message?: string; offset?: number }
) {
  requireAccountAccess(caller);
  const agent = await repo.ownedAccountAgent(caller.userId, id);
  if (agent === null) throw new AgentGraphError(404, 'Agent not found');
  const cursor = cursorFor([caller.userId, id], query.cursor);
  const limit = limitFor(query.limit, ACCOUNT_READ_DEFAULT);
  const offset = query.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 2147483646 ||
    (offset > 0 && query.message === undefined)
  ) {
    throw new AgentGraphError(400, 'offset requires a message id and a nonnegative integer');
  }
  const rows =
    query.message === undefined
      ? await repo.accountMessagePage(id, cursor, limit)
      : [await repo.accountMessageSegment(id, query.message, offset)].filter((r) => r !== null);
  const messages: Record<string, unknown>[] = [];
  let last: (typeof rows)[number] | undefined;
  for (const row of rows.slice(0, limit)) {
    // SQL offsets count Unicode codepoints, so segment sizes use the same unit.
    const text = Array.from(row.text).slice(0, 4000).join('');
    const end = offset + Array.from(text).length;
    const entry = {
      message_id: row.id,
      role: row.role,
      timestamp: row.timestamp.toISOString(),
      text,
      text_offset: offset,
      text_chars: row.totalChars,
      content_truncated: end < row.totalChars,
      more_command:
        end < row.totalChars
          ? `rose-agents read ${id} --message ${row.id} --offset ${end} --json`
          : null,
    };
    if (responseBytes({ messages: [...messages, entry] }) > ACCOUNT_PAGE_BYTES - 4096) break;
    messages.push(entry);
    last = row;
  }
  if (rows.length > 0 && messages.length === 0)
    throw new AgentGraphError(413, 'Message segment exceeds response budget');
  const next =
    query.message === undefined && rows.length > messages.length && last !== undefined
      ? encodeAccountCursor({ ...cursor, at: last.timestamp.toISOString(), id: last.id })
      : null;
  const result = {
    agent_id: id,
    messages,
    has_more: next !== null,
    next_cursor: next,
    next_command:
      next === null ? null : `rose-agents read ${id} --limit ${limit} --cursor ${next} --json`,
    snapshot: cursor.snapshot,
  };
  if (responseBytes(result) > ACCOUNT_PAGE_BYTES)
    throw new AgentGraphError(413, 'Page exceeds response budget');
  return result;
}

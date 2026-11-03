/**
 * Turn a checkpoint's CLI session log into greppable `code_event` rows.
 *
 *   cli-log.jsonl (Claude project JSONL | Codex rollout)
 *     └─ parseCodeEvents ─► {command, exitCode, output≤2KB} | {editedFile, diff≤2KB}
 *          └─ indexCodeEvents ─► AgentTrajectorySearch (traceKind = code_event)
 *
 * Row ids hash (codeSessionId, tool call id) so every checkpoint re-indexes
 * the cumulative log idempotently.
 */
import { createHash } from 'crypto';
import { prisma } from '../database';
import { upsertTrajectoryRows, type ArchivedTrajectoryRow } from '../traceArchiveSearchIndex';

export const CODE_EVENT_TRACE_KIND = 'code_event';
const EXCERPT_BYTES = 2048;
const MAX_EVENTS_PER_INDEX = 2000;

export interface CodeEvent {
  key: string;
  timestamp: Date | null;
  command?: string;
  exitCode?: number | null;
  output?: string;
  editedFile?: string;
  diff?: string;
}

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function excerpt(text: string, limit = EXCERPT_BYTES): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return text;
  // Never split a UTF-8 sequence: back up to a character boundary.
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return `${buffer.subarray(0, end).toString('utf8')}…`;
}

function timestampOf(entry: Json): Date | null {
  const raw = entry.timestamp;
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : (str(record(part)?.text) ?? '')))
      .join('\n');
  }
  return '';
}

function claudeEditDiff(input: Json, toolUseResult: Json | null): string {
  const patch = toolUseResult?.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) {
    return patch
      .map((hunk) => {
        const lines = record(hunk)?.lines;
        return Array.isArray(lines) ? lines.join('\n') : '';
      })
      .join('\n');
  }
  const oldString = str(input.old_string);
  const newString = str(input.new_string);
  if (oldString !== null || newString !== null) {
    return [
      ...(oldString ?? '').split('\n').map((line) => `-${line}`),
      ...(newString ?? '').split('\n').map((line) => `+${line}`),
    ].join('\n');
  }
  const content = str(input.content);
  return content !== null
    ? content
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n')
    : '';
}

function parseClaude(lines: Json[]): CodeEvent[] {
  const pending = new Map<string, CodeEvent>();
  const events: CodeEvent[] = [];
  for (const entry of lines) {
    const message = record(entry.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    if (entry.type === 'assistant') {
      for (const part of content) {
        const use = record(part);
        if (use?.type !== 'tool_use') continue;
        const id = str(use.id) ?? `${events.length}`;
        const name = str(use.name) ?? '';
        const input = record(use.input) ?? {};
        let event: CodeEvent | null = null;
        if (name === 'Bash' && str(input.command) !== null) {
          event = { key: id, timestamp: timestampOf(entry), command: String(input.command) };
        } else if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) {
          const file = str(input.file_path) ?? str(input.notebook_path);
          if (file !== null) {
            event = {
              key: id,
              timestamp: timestampOf(entry),
              editedFile: file,
              diff: claudeEditDiff(input, null),
            };
          }
        }
        if (event !== null) {
          pending.set(id, event);
          events.push(event);
        }
      }
    } else if (entry.type === 'user') {
      for (const part of content) {
        const result = record(part);
        if (result?.type !== 'tool_result') continue;
        const event = pending.get(str(result.tool_use_id) ?? '');
        if (event === undefined) continue;
        const toolUseResult = record(entry.toolUseResult);
        if (event.command !== undefined) {
          const text =
            toolUseResult !== null
              ? [str(toolUseResult.stdout), str(toolUseResult.stderr)].filter(Boolean).join('\n')
              : toolResultText(result.content);
          const exit = /^Exit code (\d+)/m.exec(toolResultText(result.content));
          event.exitCode = exit !== null ? Number(exit[1]) : result.is_error === true ? 1 : 0;
          event.output = text || toolResultText(result.content);
        } else if (toolUseResult !== null) {
          const diff = claudeEditDiff({}, toolUseResult);
          if (diff !== '') event.diff = diff;
        }
      }
    }
  }
  return events;
}

function codexCommand(raw: unknown): string | null {
  if (Array.isArray(raw)) {
    const parts = raw.filter((part): part is string => typeof part === 'string');
    // ["bash","-lc","<script>"] → the script is the meaningful command.
    if (parts.length === 3 && /(^|\/)(ba)?sh$/.test(parts[0]) && parts[1].startsWith('-')) {
      return parts[2];
    }
    return parts.join(' ') || null;
  }
  return str(raw);
}

function parseCodex(lines: Json[]): CodeEvent[] {
  const events: CodeEvent[] = [];
  const calls = new Map<string, CodeEvent>();
  const seenEnded = new Set<string>();
  for (const entry of lines) {
    const payload = record(entry.payload);
    if (payload === null) continue;
    const type = payload.type;
    if (entry.type === 'event_msg' && type === 'exec_command_end') {
      const id = str(payload.call_id) ?? `${events.length}`;
      seenEnded.add(id);
      const existing = calls.get(id);
      const event = existing ?? { key: id, timestamp: timestampOf(entry) };
      event.command = codexCommand(payload.command) ?? event.command;
      event.exitCode = typeof payload.exit_code === 'number' ? payload.exit_code : null;
      event.output =
        str(payload.aggregated_output) ??
        [str(payload.stdout), str(payload.stderr)].filter(Boolean).join('\n');
      if (existing === undefined && event.command !== undefined) events.push(event);
    } else if (entry.type === 'response_item' && type === 'function_call') {
      const id = str(payload.call_id) ?? `${events.length}`;
      let args: Json | null = null;
      try {
        args = record(JSON.parse(String(payload.arguments ?? '{}')));
      } catch {
        args = null;
      }
      const command = codexCommand(args?.command ?? args?.cmd);
      if (command !== null && !calls.has(id)) {
        const event: CodeEvent = { key: id, timestamp: timestampOf(entry), command };
        calls.set(id, event);
        events.push(event);
      }
    } else if (entry.type === 'response_item' && type === 'function_call_output') {
      const event = calls.get(str(payload.call_id) ?? '');
      if (event === undefined || seenEnded.has(event.key)) continue;
      let output = payload.output;
      try {
        output = JSON.parse(String(payload.output));
      } catch {
        // plain string output
      }
      const body = record(output);
      event.output = str(body?.output) ?? (typeof output === 'string' ? output : '');
      const metadata = record(body?.metadata);
      event.exitCode = typeof metadata?.exit_code === 'number' ? metadata.exit_code : null;
    } else if (
      entry.type === 'response_item' &&
      (type === 'custom_tool_call' || type === 'function_call') &&
      payload.name === 'apply_patch'
    ) {
      const input = str(payload.input) ?? str(payload.arguments) ?? '';
      const files = [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
        (match) => match[1].trim()
      );
      for (const [index, file] of files.entries()) {
        events.push({
          key: `${str(payload.call_id) ?? events.length}:${index}`,
          timestamp: timestampOf(entry),
          editedFile: file,
          diff: input,
        });
      }
    }
  }
  return events;
}

export function parseCodeEvents(codeProvider: string, log: Buffer | string): CodeEvent[] {
  const lines: Json[] = [];
  for (const line of (typeof log === 'string' ? log : log.toString('utf8')).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = record(JSON.parse(line));
      if (parsed !== null) lines.push(parsed);
    } catch {
      // A torn final line (log captured mid-write) is skipped.
    }
  }
  return codeProvider === 'codex' ? parseCodex(lines) : parseClaude(lines);
}

export function codeEventSearchText(event: CodeEvent): string {
  if (event.command !== undefined) {
    return [
      `[code_event] command: ${excerpt(event.command)}`,
      `exit_code: ${event.exitCode ?? 'unknown'}`,
      `output: ${excerpt(event.output ?? '')}`,
    ].join('\n');
  }
  return [
    `[code_event] edited: ${event.editedFile ?? ''}`,
    `diff:`,
    excerpt(event.diff ?? ''),
  ].join('\n');
}

export interface IndexCodeEventsParams {
  userId: string;
  rootAgentId: string;
  agentId: string;
  codeSessionId: string;
  codeProvider: string;
  cliLog: Buffer;
  archivePath: string;
  fallbackTime: Date;
}

/** Index one checkpoint's CLI log. Returns the number of rows written. */
export async function indexCodeEvents(params: IndexCodeEventsParams): Promise<number> {
  const events = parseCodeEvents(params.codeProvider, params.cliLog).slice(-MAX_EVENTS_PER_INDEX);
  if (events.length === 0) return 0;
  const agent = await prisma.agent.findUnique({
    where: { id: params.agentId },
    select: { goal: true, title: true, source: true },
  });
  const rows: ArchivedTrajectoryRow[] = events.map((event) => ({
    messageId: `code-${createHash('sha256')
      .update(`${params.codeSessionId}\0${event.key}`)
      .digest('hex')}`,
    userId: params.userId,
    rootAgentId: params.rootAgentId,
    agentId: params.agentId,
    surface: agent?.source ?? 'WEB',
    role: 'TOOL',
    createdAt: event.timestamp ?? params.fallbackTime,
    searchText: codeEventSearchText(event),
    agentGoal: agent?.goal ?? '',
    agentTitle: agent?.title ?? null,
    archivePath: params.archivePath,
    traceKind: CODE_EVENT_TRACE_KIND,
  }));
  await upsertTrajectoryRows(rows);
  return rows.length;
}

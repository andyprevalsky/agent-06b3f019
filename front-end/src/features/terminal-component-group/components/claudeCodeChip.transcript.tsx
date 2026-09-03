/**
 * STATE MACHINE: Completed code-agent transcript
 * [RAW] -> parsed semantic blocks (notes / tools / commands)
 * [BLOCKS] -> coherent activity log with icon rows
 * [EMPTY] -> explicit unavailable message
 */

import { type ReactNode } from 'react';
import {
  CheckCircle2,
  FilePenLine,
  FileSearch,
  FileText,
  FolderSearch,
  ListTodo,
  MessageSquareText,
  PlayCircle,
  Search,
  SquareTerminal,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';

import { type CodeProvider } from '../types';
import { normalizeTerminalWhitespace } from './claudeCodeChip.terminal';

export type TranscriptBlockKind =
  'agent' | 'tool' | 'command' | 'output' | 'exit' | 'status' | 'result' | 'plain';

export interface TranscriptBlock {
  kind: TranscriptBlockKind;
  title: string;
  tone: 'blue' | 'cyan' | 'emerald' | 'green' | 'red' | 'violet' | 'amber' | 'slate';
  icon: ReactNode;
  lines: string[];
  collapsed?: boolean;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Claude Code PTY historically LF-wrapped without CR, so durable transcripts
 * contain staircase indents and mid-token splits ("Bas" / "h"). Trim leading
 * junk and rejoin obvious continuations before semantic parsing.
 */
function healSoftWrappedTranscriptLines(output: string): string {
  const lines = output.split('\n').map((line) => {
    const trimmedEnd = line.trimEnd();
    // Only peel staircase leading spaces when they prefix a marker line.
    const marker = trimmedEnd.match(/^[ \t]{2,}(\[(?:Codex|Claude).*)$/i);
    return marker ? marker[1] : trimmedEnd;
  });
  const healed: string[] = [];
  for (const line of lines) {
    if (!healed.length) {
      healed.push(line);
      continue;
    }
    const prev = healed[healed.length - 1] ?? '';
    const startsMarker = /^\[(Codex|Claude)/i.test(line);
    const prevStartsMarker = /^\[(Codex|Claude)/i.test(prev);
    if (
      line &&
      !startsMarker &&
      prevStartsMarker &&
      /[A-Za-z0-9]$/.test(prev) &&
      !/[.!:?)]$/.test(prev) &&
      /^[a-z0-9/]/.test(line)
    ) {
      // Mid-token wrap: "[Claude tool] Bas" + "h" → "[Claude tool] Bash"
      // or "[Claude] ... checkpointi" + "ng/resumability:" → joined.
      healed[healed.length - 1] = `${prev}${line}`;
      continue;
    }
    if (line && !startsMarker && prevStartsMarker && /[a-z,]$/.test(prev) && /^[a-z]/.test(line)) {
      healed[healed.length - 1] = `${prev}${prev.endsWith(' ') ? '' : ' '}${line}`;
      continue;
    }
    healed.push(line);
  }
  return healed.join('\n');
}

function plainTranscriptText(output: string): string {
  return healSoftWrappedTranscriptLines(
    normalizeTerminalWhitespace(output)
      .replace(ANSI_PATTERN, '')
      .replace(/[▶✓✕◆]\s*/g, '')
      .replace(/\r/g, '\n'),
  );
}

function compactCommandTitle(command: string): string {
  const first = command.trim().split('\n')[0] ?? '';
  if (!first) return 'Command';
  return first.length > 110 ? `${first.slice(0, 107)}...` : first;
}

function toolIcon(toolName: string): ReactNode {
  const name = toolName.trim().toLowerCase();
  const className = 'h-4 w-4';
  if (name === 'bash' || name === 'shell' || name === 'terminal') {
    return <Terminal className={className} />;
  }
  if (name === 'read' || name === 'read_file') {
    return <FileText className={className} />;
  }
  if (name === 'write' || name === 'write_file' || name === 'edit' || name === 'edit_file') {
    return <FilePenLine className={className} />;
  }
  if (name === 'glob') {
    return <FolderSearch className={className} />;
  }
  if (name === 'grep' || name === 'search') {
    return <Search className={className} />;
  }
  if (
    name === 'websearch' ||
    name === 'web_search' ||
    name === 'webfetch' ||
    name === 'web_fetch'
  ) {
    return <FileSearch className={className} />;
  }
  if (
    name === 'todowrite' ||
    name === 'todo_write' ||
    name === 'todoread' ||
    name === 'todo_read'
  ) {
    return <ListTodo className={className} />;
  }
  return <Wrench className={className} />;
}

function commandBlock(visible: string): TranscriptBlock | null {
  const command = visible.match(
    /^\[(Codex|Claude)(?: Code)? command (started|completed)\]\s*(.*)$/i,
  );
  if (!command) return null;
  const completed = command[2].toLowerCase() === 'completed';
  const commandText = command[3] ?? '';
  return {
    kind: 'command',
    title: completed ? 'Command completed' : 'Command started',
    tone: completed ? 'blue' : 'violet',
    icon: completed ? <CheckCircle2 className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />,
    lines: commandText ? [commandText] : [],
    collapsed: commandText.length > 160,
  };
}

function exitBlock(visible: string): TranscriptBlock | null {
  const exit = visible.match(
    /^(?:\[(Codex|Claude)(?: Code)? exit_?code\]|(Codex|Claude)(?: Code)? exit\s+code)\s*(-?\d+)?$/i,
  );
  const processExit = visible.match(/^\[Process exit code\]\s*(-?\d+)?$/i);
  if (!exit && !processExit) return null;
  const code = exit?.[3] ?? processExit?.[1] ?? '0';
  const ok = code === '0';
  const process = processExit !== null;
  return {
    kind: 'exit',
    title: ok
      ? `${process ? 'Process e' : 'E'}xited cleanly`
      : `${process ? 'Process e' : 'E'}xited with code ${code}`,
    tone: ok ? 'green' : 'red',
    icon: ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />,
    lines: [`exit code ${code}`],
  };
}

function toolBlock(visible: string): TranscriptBlock | null {
  // [Claude tool] Bash · gh auth status
  // [Claude tool] Write /home/user/foo.py
  const tool = visible.match(/^\[(Codex|Claude)(?: Code)? tool\]\s+(\S+)\s*(?:·\s*(.*)|(.*))?$/i);
  if (!tool) return null;
  const toolName = tool[2] ?? 'Tool';
  const detail = (tool[3] ?? tool[4] ?? '').trim();
  return {
    kind: 'tool',
    title: toolName,
    tone: 'amber',
    icon: toolIcon(toolName),
    lines: detail ? [detail] : [],
    collapsed: detail.length > 180,
  };
}

function resultBlock(visible: string): TranscriptBlock | null {
  const result = visible.match(/^\[(Codex|Claude)(?: Code)? result\]\s*(.*)$/i);
  if (!result) return null;
  const detail = (result[2] ?? '').trim();
  const failed = /fail|error/i.test(detail.slice(0, 80));
  return {
    kind: 'result',
    title: failed ? 'Result · failed' : 'Result',
    tone: failed ? 'red' : 'green',
    icon: failed ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />,
    lines: detail ? [detail] : [],
    collapsed: detail.length > 220,
  };
}

function createBlock(line: string): TranscriptBlock | null {
  const visible = line.trim();
  if (!visible) return null;
  const tool = toolBlock(visible);
  if (tool) return tool;
  const result = resultBlock(visible);
  if (result) return result;
  const command = commandBlock(visible);
  if (command) return command;
  if (
    /^\[(?:Codex|Claude)(?: Code)? command output\]$/i.test(visible) ||
    /^(?:\[)?(?:Codex|Claude)(?: Code)? output\]?$/i.test(visible)
  ) {
    return {
      kind: 'output',
      title: 'Output',
      tone: 'cyan',
      icon: <SquareTerminal className="h-4 w-4" />,
      lines: [],
    };
  }
  const exit = exitBlock(visible);
  if (exit) return exit;
  // Must run after tool/result so "[Claude tool]" is not swallowed as a note.
  const agent = visible.match(/^\[(Codex|Claude)(?: Code)?\]\s*(.*)$/i);
  if (agent) {
    return {
      kind: 'agent',
      title: agent[1],
      tone: 'violet',
      icon: <MessageSquareText className="h-4 w-4" />,
      lines: agent[2] ? [agent[2]] : [],
    };
  }
  if (/^(Status|Verification|Artifacts|Git):/i.test(visible)) {
    return {
      kind: 'status',
      title: visible.replace(/:$/, ''),
      tone: 'emerald',
      icon: <FileText className="h-4 w-4" />,
      lines: [],
    };
  }
  return null;
}

function mergeAgentBlocks(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const merged: TranscriptBlock[] = [];
  for (const block of blocks) {
    const prev = merged[merged.length - 1];
    if (block.kind === 'agent' && prev?.kind === 'agent' && prev.title === block.title) {
      if (prev.lines.length > 0 && block.lines.length > 0) prev.lines.push('');
      prev.lines.push(...block.lines);
      continue;
    }
    merged.push({ ...block, lines: [...block.lines] });
  }
  return merged;
}

export function ParseCodeAgentTranscript(output: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  const lines = plainTranscriptText(output).split('\n');
  let current: TranscriptBlock | null = null;
  for (const line of lines) {
    const block = createBlock(line);
    if (block) {
      if (current) blocks.push(current);
      current = block;
      continue;
    }
    current ??= {
      kind: 'plain',
      title: 'Transcript',
      tone: 'slate',
      icon: <FileText className="h-4 w-4" />,
      lines: [],
    };
    if (line.trim() || current.lines.length > 0) current.lines.push(line.replace(/^›\s*/, ''));
  }
  if (current) blocks.push(current);
  return mergeAgentBlocks(
    blocks.filter(
      (block) =>
        block.lines.some((line) => line.trim()) ||
        block.kind === 'exit' ||
        block.kind === 'tool' ||
        block.kind === 'result' ||
        block.kind === 'command',
    ),
  );
}

const TRANSCRIPT_TONES: Record<TranscriptBlock['tone'], string> = {
  blue: 'border-blue-400/25 bg-blue-500/10 text-blue-100',
  cyan: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
  emerald: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
  green: 'border-green-400/25 bg-green-500/10 text-green-100',
  red: 'border-red-400/25 bg-red-500/10 text-red-100',
  violet: 'border-violet-400/25 bg-violet-500/10 text-violet-100',
  amber: 'border-amber-400/25 bg-amber-500/10 text-amber-100',
  slate: 'border-slate-400/20 bg-slate-500/10 text-slate-100',
};

function TranscriptBlockView({ block }: { block: TranscriptBlock }) {
  const body = block.lines.join('\n').trim();
  const tone = TRANSCRIPT_TONES[block.tone];

  if (block.kind === 'agent') {
    return (
      <div className="flex gap-2.5 px-1 py-1.5">
        <span className="mt-0.5 flex-shrink-0 text-violet-300/90">{block.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-violet-200/70">
            {block.title}
          </div>
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-white/88">
            {body}
          </p>
        </div>
      </div>
    );
  }

  if (block.kind === 'tool') {
    return (
      <div className={`flex gap-2.5 rounded-md border ${tone} px-3 py-2`}>
        <span className="mt-0.5 flex-shrink-0">{block.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-xs font-semibold">{block.title}</span>
            {!block.collapsed && body && body.length <= 110 && (
              <span className="min-w-0 truncate font-mono text-[11px] font-normal opacity-75">
                {body}
              </span>
            )}
          </div>
          {(block.collapsed || body.length > 110) && body && (
            <details className="mt-1">
              <summary className="cursor-pointer list-none font-mono text-[11px] opacity-70">
                {compactCommandTitle(body)}
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-black/25 p-2 font-mono text-[11px] leading-5 text-white/82">
                {body}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  if (block.collapsed) {
    return (
      <details className={`rounded-lg border ${tone} open:pb-3`}>
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold">
          <span className="flex-shrink-0">{block.icon}</span>
          <span>{block.title}</span>
          <span className="min-w-0 truncate font-mono font-normal opacity-70">
            {compactCommandTitle(body)}
          </span>
        </summary>
        <pre className="mx-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/24 p-3 font-mono text-[11px] leading-5 text-white/82">
          {body}
        </pre>
      </details>
    );
  }

  return (
    <section className={`rounded-lg border ${tone}`}>
      <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2 text-xs font-semibold">
        <span className="flex-shrink-0">{block.icon}</span>
        <span>{block.title}</span>
      </div>
      {body && (
        <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-5 text-white/82">
          {body}
        </pre>
      )}
    </section>
  );
}

export function CompletedTranscriptSurface({
  output,
  codeProvider,
  className,
}: {
  output: string;
  codeProvider: CodeProvider;
  className: string;
}) {
  const blocks = ParseCodeAgentTranscript(output);
  const label = codeProvider === 'codex' ? 'Codex' : 'Claude Code';
  const emptyMessage = output.trim() ? 'No transcript events found.' : 'Transcript unavailable.';
  return (
    <div className={`code-agent-terminal-shell relative overflow-hidden ${className}`}>
      <div className="code-agent-terminal-titlebar absolute inset-x-0 top-0 z-10 flex h-9 items-center justify-between border-b border-white/10 px-3">
        <div className="flex items-center gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b6b]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#f7d774]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#7ee787]" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-white/58">
          <FileText className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{label} log</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] font-medium text-white/52">
          {blocks.length} events
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-9 overflow-y-auto p-3">
        {blocks.length > 0 ? (
          <div className="space-y-1.5">
            {blocks.map((block, index) => (
              <TranscriptBlockView key={`${block.kind}-${index}`} block={block} />
            ))}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-white/58">
            {emptyMessage}
          </div>
        )}
      </div>
    </div>
  );
}

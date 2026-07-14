/**
 * STATE MACHINE: Completed code-agent transcript
 * [RAW] -> parsed semantic blocks
 * [BLOCKS] -> event cards
 * [EMPTY] -> explicit unavailable message
 */

import { type ReactNode } from 'react';
import {
  CheckCircle2,
  FileText,
  MessageSquareText,
  PlayCircle,
  SquareTerminal,
  XCircle,
} from 'lucide-react';

import { type CodeProvider } from '../types';
import { normalizeTerminalWhitespace } from './claudeCodeChip.terminal';

export type TranscriptBlockKind = 'agent' | 'command' | 'output' | 'exit' | 'status' | 'plain';

export interface TranscriptBlock {
  kind: TranscriptBlockKind;
  title: string;
  tone: 'blue' | 'cyan' | 'emerald' | 'green' | 'red' | 'violet' | 'slate';
  icon: ReactNode;
  lines: string[];
  collapsed?: boolean;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function plainTranscriptText(output: string): string {
  return normalizeTerminalWhitespace(output)
    .replace(ANSI_PATTERN, '')
    .replace(/[▶✓✕◆]\s*/g, '')
    .replace(/\r/g, '\n');
}

function compactCommandTitle(command: string): string {
  const first = command.trim().split('\n')[0] ?? '';
  if (!first) return 'Command';
  return first.length > 110 ? `${first.slice(0, 107)}...` : first;
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

function createBlock(line: string): TranscriptBlock | null {
  const visible = line.trim();
  if (!visible) return null;
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
  const agent = visible.match(/^\[(Codex|Claude)(?: Code)?\]\s*(.*)$/i);
  if (agent) {
    return {
      kind: 'agent',
      title: `${agent[1]} note`,
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
  return blocks.filter((block) => block.lines.some((line) => line.trim()) || block.kind === 'exit');
}

const TRANSCRIPT_TONES: Record<TranscriptBlock['tone'], string> = {
  blue: 'border-blue-400/25 bg-blue-500/10 text-blue-100',
  cyan: 'border-cyan-400/25 bg-cyan-500/10 text-cyan-100',
  emerald: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-100',
  green: 'border-green-400/25 bg-green-500/10 text-green-100',
  red: 'border-red-400/25 bg-red-500/10 text-red-100',
  violet: 'border-violet-400/25 bg-violet-500/10 text-violet-100',
  slate: 'border-slate-400/20 bg-slate-500/10 text-slate-100',
};

function TranscriptBlockView({ block }: { block: TranscriptBlock }) {
  const body = block.lines.join('\n').trim();
  const tone = TRANSCRIPT_TONES[block.tone];
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
          <span className="truncate">{label} transcript</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/6 px-2 py-0.5 text-[10px] font-medium text-white/52">
          {blocks.length} events
        </span>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-9 overflow-y-auto p-3">
        {blocks.length > 0 ? (
          <div className="space-y-2">
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

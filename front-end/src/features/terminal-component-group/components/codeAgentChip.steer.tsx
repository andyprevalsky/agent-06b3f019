/**
 * STATE MACHINE: Code-agent steering surfaces (Rose Desktop chip, rows 45 + 47)
 *
 * TRANSCRIPT:
 *   [EMPTY] → "Waiting for <agent>…"
 *   [EVENTS] → thinking (collapsed ⇄ expanded) · assistant messages · compact tool rows
 *              · "You → <agent>" rows (session echoes + local echoes not yet echoed back)
 *   new rows → scroll to bottom
 *
 * STEER INPUT:
 *   [IDLE] → (Enter / send, non-empty) → [SENDING] → ok: echo + clear → [IDLE]
 *                                                  → error: keep text, show error → [IDLE]
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowUp, ChevronRight, Loader2 } from 'lucide-react';

import {
  codeAgentLabel,
  eventTimeMs,
  sendCodeAgentMessage,
  type CodeAgentProvider,
  type CodeAgentToolCall,
  type CodeAgentTranscriptEvent,
} from '../hooks/codeAgentContract';
import { addLocalEcho, type LocalEcho } from '../hooks/codeAgentLocalState';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

type Row =
  | { kind: 'event'; event: CodeAgentTranscriptEvent; at: number; thinkingSeconds?: number }
  | { kind: 'echo'; text: string; at: number };

function buildRows(events: CodeAgentTranscriptEvent[], echoes: readonly LocalEcho[]): Row[] {
  const echoedBack = new Set(
    events.filter((e) => e.role === 'user' && e.text).map((e) => e.text as string),
  );
  const rows: Row[] = events.map((event, index) => {
    const at = eventTimeMs(event.ts) ?? 0;
    const next = events[index + 1];
    const nextAt = next ? eventTimeMs(next.ts) : null;
    const thinkingSeconds =
      event.type === 'thinking' && nextAt !== null
        ? Math.max(0, Math.round((nextAt - at) / 1000))
        : undefined;
    return { kind: 'event', event, at, thinkingSeconds };
  });
  for (const echo of echoes) {
    if (!echoedBack.has(echo.text)) rows.push({ kind: 'echo', text: echo.text, at: echo.at });
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.at - b.row.at || a.index - b.index)
    .map(({ row }) => row);
}

function ThinkingRow({ text, seconds }: { text: string; seconds?: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`text-[13px] italic ${MUTED}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 italic"
      >
        {seconds !== undefined ? `Thinking · ${seconds}s` : 'Thinking'}
        <ChevronRight className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 border-l-2 border-border pl-2.5 dark:border-white/[.09]">{text}</div>
      )}
    </div>
  );
}

function resultTone(ok: boolean | undefined): string {
  if (ok === true) return 'text-green-600 dark:text-green-400';
  if (ok === false) return 'text-red-600 dark:text-red-400';
  return MUTED;
}

function ToolRow({ tool }: { tool: CodeAgentToolCall }) {
  return (
    <div
      data-testid="code-agent-tool-row"
      className="flex items-baseline gap-2 font-mono text-[12.5px] text-foreground/75 dark:text-[#ecece8]/80"
    >
      <span className={`min-w-[42px] ${MUTED}`}>{tool.name}</span>
      <span className="min-w-0 truncate">{tool.target}</span>
      {tool.added !== undefined && (
        <span className="text-green-600 dark:text-green-400">+{tool.added}</span>
      )}
      {tool.removed !== undefined && (
        <span className="text-red-600 dark:text-red-400">−{tool.removed}</span>
      )}
      {tool.result && <span className={resultTone(tool.ok)}>{tool.result}</span>}
    </div>
  );
}

function YouRow({ text, label }: { text: string; label: string }) {
  return (
    <div className="text-foreground dark:text-[#ecece8]">
      <span className={MUTED}>You → {label}:</span> {text}
    </div>
  );
}

export function CodeAgentTranscript({
  events,
  echoes,
  provider,
}: {
  events: CodeAgentTranscriptEvent[];
  echoes: readonly LocalEcho[];
  provider: CodeAgentProvider;
}) {
  const label = codeAgentLabel(provider);
  const rows = useMemo(() => buildRows(events, echoes), [events, echoes]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [rows.length]);

  return (
    <div
      ref={scrollRef}
      data-testid="code-agent-transcript"
      className="flex max-h-[300px] flex-col gap-2 overflow-auto px-3.5 pb-1 pt-2.5 text-[13.5px]"
    >
      {rows.length === 0 && <div className={`text-[13px] ${MUTED}`}>Waiting for {label}…</div>}
      {rows.map((row, index) => {
        const key = `${row.kind}-${row.at}-${index}`;
        if (row.kind === 'echo') return <YouRow key={key} text={row.text} label={label} />;
        const { event } = row;
        if (event.type === 'thinking') {
          return <ThinkingRow key={key} text={event.text ?? ''} seconds={row.thinkingSeconds} />;
        }
        if (event.type === 'tool' && event.tool) return <ToolRow key={key} tool={event.tool} />;
        if (event.role === 'user') return <YouRow key={key} text={event.text ?? ''} label={label} />;
        return (
          <div key={key} className="text-foreground dark:text-[#ecece8]">
            {event.text}
          </div>
        );
      })}
    </div>
  );
}

export type ChipTab = 'transcript' | 'terminal';

export function ChipTabs({ tab, onChange }: { tab: ChipTab; onChange: (tab: ChipTab) => void }) {
  const tabs: Array<{ id: ChipTab; label: string }> = [
    { id: 'transcript', label: 'Transcript' },
    { id: 'terminal', label: 'Terminal' },
  ];
  return (
    <div
      role="tablist"
      className="flex gap-4 border-t border-border px-3.5 text-[12.5px] dark:border-white/[.09]"
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          onClick={() => onChange(t.id)}
          className={
            tab === t.id
              ? 'py-2 font-semibold text-foreground shadow-[inset_0_-2px_0_#e8507f] dark:text-[#ecece8]'
              : `py-2 ${MUTED} hover:text-foreground dark:hover:text-[#ecece8]`
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function CodeAgentSteerInput({
  agentId,
  taskId,
  provider,
}: {
  agentId: string | null;
  taskId: string;
  provider: CodeAgentProvider;
}) {
  const label = codeAgentLabel(provider);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending || !agentId) return;
    setSending(true);
    setError(null);
    try {
      await sendCodeAgentMessage(agentId, taskId, value);
      addLocalEcho(taskId, value);
      setText('');
    } catch (err) {
      setError(`Couldn't reach ${label}: ${err instanceof Error ? err.message : 'send failed'}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-3.5 mb-3 mt-1.5">
      <form
        onSubmit={(event) => void submit(event)}
        className="flex items-center gap-2 rounded-[10px] border border-border bg-white py-2 pl-3 pr-2.5 dark:border-white/[.09] dark:bg-[#2f2f2c]"
      >
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`Message ${label} directly…`}
          aria-label={`Message ${label} directly`}
          disabled={!agentId}
          className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none placeholder:text-muted-foreground dark:text-[#ecece8] dark:placeholder:text-[#a3a39d]"
        />
        <span className={`hidden whitespace-nowrap text-[11.5px] sm:inline ${MUTED}`}>
          goes straight to its session
        </span>
        <button
          type="submit"
          aria-label={`Send to ${label}`}
          disabled={sending || !text.trim() || !agentId}
          className="grid h-[26px] w-[26px] flex-shrink-0 place-items-center rounded-full bg-[#272725] text-white disabled:opacity-50 dark:bg-[#ecece8] dark:text-[#262624]"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUp className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

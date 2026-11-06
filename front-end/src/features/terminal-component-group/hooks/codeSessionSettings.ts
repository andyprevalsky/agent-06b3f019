/**
 * A code session's working settings, read from its own transcript records
 * (agents/utils/code_transcript.py `to_ui_record`) on the owner's rows:
 *
 *   type 'session' (CLI init)  → model / speed / effort the CLI runs with
 *   type 'metrics'             → context_tokens: the latest model call's prompt
 *                                (input + cache read + cache write);
 *                                context_window: the model's window
 *
 * The latest record wins (by ts, then seq). Absent fields stay undefined: the
 * query box then shows nothing for them, never a placeholder or a guess.
 */

import type { Message } from '@/lib/api/types';

import { eventTimeMs } from './codeAgentContract';

export interface CodeSessionSettings {
  model?: string;
  speed?: string;
  effort?: string;
  contextTokens?: number;
  contextWindow?: number;
}

type Rec = Record<string, unknown>;

function records(message: Message): Rec[] {
  const raw = message.metadata?.code_agent_events;
  return Array.isArray(raw)
    ? raw.filter((r): r is Rec => !!r && typeof r === 'object' && !Array.isArray(r))
    : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function order(record: Rec): [number, number] {
  const seq = typeof record.seq === 'number' ? record.seq : 0;
  return [eventTimeMs(record.ts as string | undefined) ?? 0, seq];
}

function later(a: [number, number], b: [number, number]): boolean {
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

export function codeSessionSettings(messages: Message[], taskId: string): CodeSessionSettings {
  const settings: CodeSessionSettings = {};
  let sessionAt: [number, number] = [-1, -1];
  let contextAt: [number, number] = [-1, -1];
  let windowAt: [number, number] = [-1, -1];
  for (const message of messages) {
    if (message.metadata?.task_id !== taskId || message.metadata.isCodeTranscript !== true)
      continue;
    for (const record of records(message)) {
      const at = order(record);
      if (record.type === 'session' && later(at, sessionAt)) {
        sessionAt = at;
        settings.model = text(record.model) ?? settings.model;
        settings.speed = text(record.speed) ?? settings.speed;
        settings.effort = text(record.effort) ?? settings.effort;
      } else if (record.type === 'metrics') {
        if (positive(record.context_tokens) && later(at, contextAt)) {
          contextAt = at;
          settings.contextTokens = record.context_tokens;
        }
        if (positive(record.context_window) && later(at, windowAt)) {
          windowAt = at;
          settings.contextWindow = record.context_window;
        }
      }
    }
  }
  return settings;
}

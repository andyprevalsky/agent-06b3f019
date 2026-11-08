/**
 * Waited-on agent kinds for WaitAgentTargets icons: the worker's
 * metadata.targetTypes, else the transcript's background spawn rows
 * (backgroundAgentType by task path; a code agent's provider from its rows'
 * code_provider). Never read from goal text.
 */
import type { Message } from '../hooks';
import type { WaitAgentTarget } from './waitForPhrase';

export type WaitAgentKind = 'claude' | 'codex' | 'browser' | 'explore' | 'agent';

function agentKind(type: unknown): WaitAgentKind | 'code' | null {
  if (type === 'code' || type === 'browser' || type === 'explore') return type;
  if (type === 'general_purpose' || type === 'for_each' || type === 'agent') return 'agent';
  return null;
}

function lastSegment(path: string): string | null {
  return path.includes('/') ? (path.split('/').filter(Boolean).at(-1) ?? null) : null;
}

const transcriptCache = new WeakMap<Message[], Map<string, WaitAgentKind>>();

/** Background spawns of a transcript by task path, task name and owner id → their kind. */
export function waitAgentKindsFromTranscript(messages: Message[]): Map<string, WaitAgentKind> {
  const cached = transcriptCache.get(messages);
  if (cached) return cached;
  const spawns = new Map<string, { type: string; path: string | null }>();
  const providers = new Map<string, string>();
  for (const message of messages) {
    const metadata = message.metadata;
    const callId = typeof metadata?.toolCallId === 'string' ? metadata.toolCallId : null;
    if (!metadata || !callId) continue;
    const owner = callId.split(':')[0];
    if (metadata.runInBackground === true && typeof metadata.backgroundAgentType === 'string') {
      const path = metadata.backgroundPath ?? metadata.backgroundAddress;
      spawns.set(owner, {
        type: metadata.backgroundAgentType,
        path: typeof path === 'string' ? path : null,
      });
    }
    if (metadata.code_provider === 'codex' || metadata.code_provider === 'claude') {
      providers.set(owner, metadata.code_provider);
    }
  }
  const kinds = new Map<string, WaitAgentKind>();
  for (const [owner, spawn] of spawns) {
    const base = agentKind(spawn.type);
    if (!base) continue;
    const kind = base === 'code' ? (providers.get(owner) === 'codex' ? 'codex' : 'claude') : base;
    for (const key of [owner, spawn.path, spawn.path ? lastSegment(spawn.path) : null]) {
      if (key) kinds.set(key, kind);
    }
  }
  transcriptCache.set(messages, kinds);
  return kinds;
}

const TYPES_WITHOUT_TRANSCRIPT = new Set([
  'code:claude',
  'code:codex',
  'browser',
  'explore',
  'general_purpose',
  'for_each',
  'agent',
]);

/** False when the worker's type alone picks the icon (no transcript scan needed). */
export function waitAgentKindNeedsTranscript(target: WaitAgentTarget): boolean {
  return !target.type || !TYPES_WITHOUT_TRANSCRIPT.has(target.type);
}

/**
 * One target's icon kind: the worker's type first ('code:claude' / 'code:codex'
 * name the CLI; plain 'code' from older workers), the transcript fills the CLI
 * or the whole kind when the worker sent none (a null/missing entry: unknown).
 */
export function waitAgentKind(
  target: WaitAgentTarget,
  transcript: ReadonlyMap<string, WaitAgentKind>,
): WaitAgentKind | null {
  if (target.type === 'code:codex') return 'codex';
  if (target.type === 'code:claude') return 'claude';
  const known =
    (target.address ? transcript.get(target.address) : undefined) ?? transcript.get(target.name);
  const declared = agentKind(target.type);
  if (declared === 'code') return known === 'codex' || known === 'claude' ? known : 'claude';
  return declared ?? known ?? null;
}

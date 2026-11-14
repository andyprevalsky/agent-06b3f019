/**
 * STATE MACHINE: WaitAgentTargets (stateless)
 *
 * "<prefix> [icon] Task Title, [icon] Task Title<suffix>" for a wait_for row
 * that waits on agents (the work row's header and its expanded card).
 *
 * ICON per waited-on agent:
 *   code, Codex provider       → Codex logo
 *   code, Claude / unknown     → Claude Code logo (the code agent default)
 *   browser                    → browser globe (spawn_browser_agent icon)
 *   explore                    → explore search (spawn_explore_agent icon)
 *   general purpose / for_each → agents icon (spawn_general_purpose_agent icon)
 *   unknown                    → no icon
 *
 * KIND: the worker's metadata.targetTypes ('code:claude' / 'code:codex' name
 * the CLI; the transcript is not scanned when every type picks its icon), else
 * (null / missing / plain 'code') the transcript's background spawn rows (backgroundAgentType by
 * task path; a code agent's CLI from its rows' code_provider). Never read from
 * goal text.
 */
import { useContext } from 'react';
import CodexIcon from '@/assets/codex-color.svg';
import { AgentContext, type Message } from '../hooks';
import { claudeCodeIconSrc, getToolIcon } from '@/lib/toolIcons';
import {
  waitAgentKind,
  waitAgentKindNeedsTranscript,
  waitAgentKindsFromTranscript,
  type WaitAgentKind,
} from './waitAgentKinds';
import { waitAgentTargets } from './waitForPhrase';

const NO_MESSAGES: Message[] = [];
const NO_KINDS: ReadonlyMap<string, WaitAgentKind> = new Map();
const ICON_CLASS = 'mr-1 inline-block h-3.5 w-3.5 align-[-0.15em]';

function KindIcon({ kind }: { kind: WaitAgentKind }) {
  const common = { 'data-testid': 'wait-agent-icon', 'data-agent-kind': kind } as const;
  if (kind === 'claude') {
    return <img {...common} src={claudeCodeIconSrc} alt="Claude Code" className={ICON_CLASS} />;
  }
  if (kind === 'codex')
    return <img {...common} src={CodexIcon} alt="Codex" className={ICON_CLASS} />;
  const tool =
    kind === 'browser'
      ? 'spawn_browser_agent'
      : kind === 'explore'
        ? 'spawn_explore_agent'
        : 'spawn_general_purpose_agent';
  const Icon = getToolIcon(tool);
  return <Icon {...common} aria-hidden className={ICON_CLASS} />;
}

/** The targets with their icons, or null when the row names no agents. */
export function WaitAgentTargets({
  metadata,
  prefix,
  suffix = '',
}: {
  metadata: Record<string, unknown> | undefined;
  prefix: string;
  suffix?: string;
}) {
  const messages = useContext(AgentContext)?.messages;
  const targets = waitAgentTargets(metadata);
  if (!targets) return null;
  // Scan the transcript only when some target's worker type cannot pick its icon alone.
  const transcript = targets.some(waitAgentKindNeedsTranscript)
    ? waitAgentKindsFromTranscript(messages ?? NO_MESSAGES)
    : NO_KINDS;
  return (
    <span data-testid="wait-agent-targets">
      {prefix}{' '}
      {targets.map((target, index) => {
        const kind = waitAgentKind(target, transcript);
        return (
          <span key={`${target.name}:${index}`}>
            {index > 0 && ', '}
            <span data-testid="wait-agent-target">
              {kind && <KindIcon kind={kind} />}
              {target.title}
            </span>
          </span>
        );
      })}
      {suffix}
    </span>
  );
}

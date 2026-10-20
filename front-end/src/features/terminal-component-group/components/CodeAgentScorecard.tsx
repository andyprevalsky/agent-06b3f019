/**
 * STATE MACHINE: Code-agent messages in the trajectory (Rose Desktop, row 46)
 *
 *   [message has metadata.from_code_agent] → "<agent> · via send_message_to_user" line
 *   [inlineView { view: 'scorecard' } without versionId] → host scorecard table
 *       tone pass → green · fail → red · warn → amber · info → blue · none → plain
 *   [neither] → nothing (stock rendering continues)
 *
 * Stateless: everything derives from the message metadata.
 */

import {
  codeAgentLabel,
  type CodeAgentSender,
  type ScorecardInlineView,
  type ScorecardTone,
} from '../hooks/codeAgentContract';
import { ProviderIcon } from './claudeCodeChip.shared';

const TONE_CLASS: Record<ScorecardTone, string> = {
  pass: 'font-semibold text-green-600 dark:text-green-400',
  fail: 'font-semibold text-red-600 dark:text-red-400',
  warn: 'font-semibold text-amber-600 dark:text-amber-400',
  info: 'font-semibold text-blue-600 dark:text-blue-400',
};

export function CodeAgentAttribution({
  sender,
  via = 'send_message_to_user',
}: {
  sender: CodeAgentSender;
  via?: string;
}) {
  return (
    <div
      data-testid="code-agent-attribution"
      className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground dark:text-[#a3a39d]"
    >
      <ProviderIcon codeProvider={sender.provider} className="h-3.5 w-3.5 flex-shrink-0" />
      <span>
        {codeAgentLabel(sender.provider)} · via {via}
      </span>
    </div>
  );
}

export function ScorecardCard({ scorecard }: { scorecard: ScorecardInlineView }) {
  return (
    <div
      data-testid="code-agent-scorecard"
      className="rounded-xl border border-border bg-white px-3.5 py-3 text-foreground dark:border-white/[.09] dark:bg-[#262624] dark:text-[#ecece8]"
    >
      {scorecard.title && (
        <h4 className="mb-2 text-[13.5px] font-semibold leading-snug">{scorecard.title}</h4>
      )}
      <dl>
        {scorecard.rows.map((row, index) => (
          <div
            key={`${index}-${row.label}`}
            data-testid="scorecard-row"
            data-tone={row.tone ?? 'none'}
            className="grid grid-cols-[1fr_auto] gap-3 border-t border-black/[.06] py-[5px] text-[13px] dark:border-white/[.07]"
          >
            <dt>{row.label}</dt>
            <dd className={row.tone ? TONE_CLASS[row.tone] : ''}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

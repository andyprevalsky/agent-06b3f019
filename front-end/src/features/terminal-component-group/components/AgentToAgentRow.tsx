/**
 * STATE MACHINE: AgentToAgentRow (Rose Desktop, rows 12 + 47b)
 *
 * Stateless; derives from `metadata.a2a` (parsed in codeAgentContract.ts):
 *   [kind 'message']  → "<icon> <from> → <to>" line, then the sender's text
 *   [kind 'question'] → "<icon> <from> asks" header (pinned-question look, inline)
 *                       + "→ <to>", then the question
 *   icon = the code agent's provider icon on either side; none between Rose agents
 *
 * Never a user bubble: a USER-role row carrying a2a is another agent speaking.
 */

import { agentToAgentCodeProvider, type AgentToAgentMessage } from '../hooks/codeAgentContract';
import { ProviderIcon } from './claudeCodeChip.shared';

const MUTED = 'text-muted-foreground dark:text-[#a3a39d]';

export function AgentToAgentRow({
  a2a,
  compact = false,
}: {
  a2a: AgentToAgentMessage;
  /** Inside a code-agent transcript (13.5px rows) rather than the trajectory. */
  compact?: boolean;
}) {
  const provider = agentToAgentCodeProvider(a2a);
  const icon = provider ? (
    <ProviderIcon
      codeProvider={provider}
      className={a2a.kind === 'question' ? 'h-4 w-4 flex-shrink-0' : 'h-3.5 w-3.5 flex-shrink-0'}
    />
  ) : null;
  const body = compact ? 'text-[13.5px]' : 'text-sm';

  return (
    <div
      data-testid="a2a-row"
      data-a2a-kind={a2a.kind}
      data-a2a-direction={a2a.direction}
      className="min-w-0 text-foreground dark:text-[#ecece8]"
    >
      {a2a.kind === 'question' ? (
        <div className="mb-1 flex items-center gap-2 text-sm">
          {icon}
          <span className="font-medium">{a2a.from.label} asks</span>
          <span className={`text-xs ${MUTED}`}>→ {a2a.to.label}</span>
        </div>
      ) : (
        <div className={`mb-0.5 flex items-center gap-1.5 text-xs ${MUTED}`}>
          {icon}
          <span>
            {a2a.from.label} → {a2a.to.label}
          </span>
        </div>
      )}
      <div className={`whitespace-pre-wrap break-words ${body}`}>{a2a.text}</div>
    </div>
  );
}

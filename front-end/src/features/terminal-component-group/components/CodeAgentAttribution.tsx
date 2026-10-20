/**
 * STATE MACHINE: CodeAgentAttribution (Rose Desktop, row 46)
 *
 *   [row has metadata.requestingAgent of kind 'code_agent'] → "<agent> · via <tool>" line
 *   [otherwise] → not rendered (stock rendering continues)
 *
 * Stateless: everything derives from the message metadata. Scorecards and
 * games are user-published inline views (`inlineView {view, versionId, props}`)
 * rendered by InlineUserView beneath the same row.
 */

import type { RequestingAgent } from '../hooks/codeAgentContract';
import { ProviderIcon } from './claudeCodeChip.shared';

export function CodeAgentAttribution({
  requester,
  via = 'send_message_to_user',
}: {
  requester: RequestingAgent;
  via?: string;
}) {
  return (
    <div
      data-testid="code-agent-attribution"
      className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground dark:text-[#a3a39d]"
    >
      {requester.provider && (
        <ProviderIcon codeProvider={requester.provider} className="h-3.5 w-3.5 flex-shrink-0" />
      )}
      <span>
        {requester.label} · via {via}
      </span>
    </div>
  );
}

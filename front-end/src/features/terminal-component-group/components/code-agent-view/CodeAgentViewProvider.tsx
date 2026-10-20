/**
 * STATE MACHINE: CodeAgentViewProvider (Rose Desktop only; `enabled` = flag)
 *
 *   [CLOSED] chat column shows the selected agent's conversation
 *     --open(code agent) (left-bar code-agent row)--> [OPEN]
 *         selects the owner agent first when another agent is selected;
 *         URL gains ?code-agent=<task id> (agent-id stays the owner)
 *     --page load with ?agent-id=<owner>&code-agent=<task id>--> [OPEN] (deep link)
 *   [OPEN] chat column shows that code agent's own conversation
 *     --close() (Escape, the parent / another agent row)--> [CLOSED]
 *     --open(another code agent)--> [OPEN] that one
 *     --selected agent moves off the owner (another row, Home, a view)--> [CLOSED]
 *   Every close removes ?code-agent. Flag off: always reads [CLOSED], open() is a no-op.
 *
 * Holds one id pair; nothing is fetched or polled here (the view reads the
 * owner's already-loaded messages).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  CodeAgentViewContext,
  codeAgentFromUrl,
  writeCodeAgentUrl,
  type CodeAgentViewValue,
  type OpenCodeAgent,
} from './codeAgentViewState';

export function CodeAgentViewProvider({
  enabled,
  selectedAgentId,
  onSelectAgent,
  children,
}: {
  enabled: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  children: ReactNode;
}) {
  // Read even before the account (and so the flag) is known; exposed only when enabled.
  const [openCodeAgent, setOpenCodeAgent] = useState<OpenCodeAgent | null>(codeAgentFromUrl);
  const previousSelection = useRef(selectedAgentId);

  const close = useCallback(() => {
    setOpenCodeAgent(null);
    writeCodeAgentUrl(null);
  }, []);

  const open = useCallback(
    (codeAgent: OpenCodeAgent) => {
      if (!enabled) return;
      if (codeAgent.ownerAgentId !== selectedAgentId) onSelectAgent(codeAgent.ownerAgentId);
      setOpenCodeAgent(codeAgent);
      writeCodeAgentUrl(codeAgent.taskId);
    },
    [enabled, onSelectAgent, selectedAgentId],
  );

  // Selecting away from the owner (another row, Home, a view) leaves the code agent.
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = selectedAgentId;
    if (openCodeAgent === null || previous === selectedAgentId) return;
    if (previous === openCodeAgent.ownerAgentId) close();
  }, [close, openCodeAgent, selectedAgentId]);

  const value = useMemo<CodeAgentViewValue>(
    () => ({ openCodeAgent: enabled ? openCodeAgent : null, open, close }),
    [close, enabled, open, openCodeAgent],
  );
  return <CodeAgentViewContext.Provider value={value}>{children}</CodeAgentViewContext.Provider>;
}

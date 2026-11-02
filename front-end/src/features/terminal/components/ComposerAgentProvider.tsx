import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AgentSlice } from '../types';
import { ComposerAgentContext, disposeComposerOwner } from './composerAgentContext';

export function ComposerAgentProvider({
  agents,
  children,
}: {
  agents: AgentSlice;
  children: ReactNode;
}) {
  const current = useRef<AgentSlice | null>(agents);
  current.current = agents;
  useLayoutEffect(() => {
    current.current = agents;
  });
  useLayoutEffect(() => {
    return disposeComposerOwner(current);
  }, [current]);
  return <ComposerAgentContext.Provider value={current}>{children}</ComposerAgentContext.Provider>;
}

import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { AgentSlice } from '../types';
import {
  ComposerAgentContext,
  ComposerOwnerContext,
  disposeComposerOwner,
} from './composerAgentContext';

export function ComposerAgentProvider({
  agents,
  children,
}: {
  agents: AgentSlice;
  children: ReactNode;
}) {
  const current = useRef<AgentSlice | null>(agents);
  useLayoutEffect(() => {
    current.current = agents;
  });
  useLayoutEffect(() => {
    return disposeComposerOwner(current);
  }, [current]);
  return (
    <ComposerOwnerContext.Provider value={current}>
      <ComposerAgentContext.Provider value={agents}>{children}</ComposerAgentContext.Provider>
    </ComposerOwnerContext.Provider>
  );
}

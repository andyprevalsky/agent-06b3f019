/**
 * STATE MACHINE: AgentContext Runtime Wrapper
 *
 * [MOUNTED] --> delegates to feature-layer implementation.
 */

export type {
  StreamingBubble,
  AgentContextValue,
  AgentProviderProps,
} from '@/features/agent-context';
export { AgentProvider, useAgentContext, AgentContext } from '@/features/agent-context';
export { default } from '@/features/agent-context';

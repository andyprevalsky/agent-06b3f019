/**
 * STATE MACHINE: Terminal (Main App View)
 *
 * HIGH-LEVEL VIEW STATES:
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │                      currentView                                    │
 * │  'agents' | 'integrations' | 'settings' | 'usage' | 'network'      │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * AGENT SELECTION FLOW:
 * ┌──────────────────┐     selectAgent(id)    ┌──────────────────────┐
 * │  NO_AGENT        │ ────────────────────> │  AGENT_SELECTED      │
 * │  selectedAgentId │                        │  selectedAgentId=id  │
 * │  = null          │ <──────────────────── │  messages, agentDetail│
 * └──────────────────┘    handleCreateNewAgent └──────────────────────┘
 *
 * OPENING ANIMATION (when NO_AGENT):
 * [REVEALING] --> revealProgress=100 --> [PAUSED] --> pauseDuration --> [FADING]
 *      ^                                                                    |
 *      └──────────── currentMessageIndex++ ────────────────────────────────┘
 *      ...until isTypingComplete=true (last message shown)
 *
 * MESSAGE SENDING FLOW:
 * ┌────────────────┐                      ┌─────────────────────┐
 * │  IDLE          │ ──── submit ───────> │  SENDING            │
 * │  isSendingMsg  │                      │  isSendingMessage   │
 * │  = false       │ <─── success/error ─ │  = true             │
 * └────────────────┘                      └─────────────────────┘
 *
 * AGENT STATUS (from agentDetail.status):
 * - STARTING_UP: Show "Loading AI Network..."
 * - ACTIVE: Show messages, can pause
 * - PAUSED: Can resume or send message
 * - COMPLETED: Show completion UI
 * - FAILED: Dimmed input
 * - OUT_OF_CREDITS: Show credit modal
 * - COST_LIMIT_REACHED: Show cost limit modal (resumable)
 *
 * MODAL STATES:
 * - createModalOpen: Create agent modal
 * - loginModalOpen: Phone auth modal
 * - showCreditModal: Subscription modal
 * - showCostLimitModal: Cost limit modal
 *
 * DRIPPINESS CONTROLS (persisted to localStorage):
 * - backgroundColors, blur, shadowIntensity, borderColor (0-100 each)
 */

import { useRef, useCallback } from 'react';

import { useAuth } from '@/hooks/useAuth';
import { AgentProvider } from '@/contexts/AgentContext';

import { TerminalContent } from './TerminalContent';

// ── Main Terminal component — wraps content in AgentProvider ──────────────

export default function Terminal() {
  const { user: authUser, isFullySignedIn, isAuthenticated, realtimeReady } = useAuth();
  const user = isFullySignedIn ? authUser : null;

  const loadAgentsRef = useRef<(() => void) | null>(null);

  const handleLoadAgents = useCallback(() => {
    loadAgentsRef.current?.();
  }, []);

  return (
    <AgentProvider
      user={user}
      isAuthenticated={isAuthenticated}
      realtimeReady={realtimeReady}
      onLoadAgents={handleLoadAgents}
    >
      <TerminalContentWithRef loadAgentsRef={loadAgentsRef} />
    </AgentProvider>
  );
}

function TerminalContentWithRef({
  loadAgentsRef,
}: {
  loadAgentsRef: React.MutableRefObject<(() => void) | null>;
}) {
  return <TerminalContent loadAgentsRef={loadAgentsRef} />;
}

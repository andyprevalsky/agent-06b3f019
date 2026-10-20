/**
 * STATE MACHINE: AppScreenHost (Rose Desktop app view inside the agents column)
 *
 * Stateless glue between the terminal and UserAppScreen
 * (terminal-component-group/components/user-apps): it renders the normal query
 * box (same QueryInput, Popular Goals never mounted) bound to the app view's
 * composer, and supplies the NEW AGENT route:
 *   onStartAgent(goal) → agents.handleCreateAgent({ goal, model, price limit })
 *     → POST /api/agents (the agent is selected underneath; the app stays open)
 * Steering a code session is owned by UserAppScreen itself.
 */
import {
  QueryInput,
  UserAppScreen,
  type AppQueryBoxBinding,
  type OpenAppView,
} from '@/features/terminal-component-group';

import type { AgentSlice, DripSlice, FilePointer, Model } from '../types';
import { queryBoxModels } from './queryBoxModels';

interface AppScreenHostProps {
  view: OpenAppView;
  onClose: () => void;
  agents: AgentSlice;
  drip: DripSlice;
  models: Model[];
  modelsLoading: boolean;
}

/** The full-screen app view with the normal query box (Popular Goals hidden). */
export function AppScreenHost({
  view,
  onClose,
  agents: a,
  drip,
  models,
  modelsLoading,
}: AppScreenHostProps) {
  const startAgent = async (goal: string, attachments?: FilePointer[]) => {
    if (a.handleCreateAgent === undefined) throw new Error('agent creation is unavailable');
    await a.handleCreateAgent({
      goal,
      model: a.selectedModel,
      price_limit_cents: a.pendingPriceLimitCents,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    });
  };
  const renderQueryBox = (binding: AppQueryBoxBinding) => (
    <QueryInput
      opaqueSurface
      value={binding.value}
      onChange={binding.onChange}
      onSubmit={binding.onSubmit}
      disabled={binding.disabled}
      placeholder={binding.placeholder}
      selectedModel={a.selectedModel}
      onModelChange={a.setSelectedModel}
      fastMode={a.fastMode}
      onFastModeChange={a.setFastMode}
      availableModels={queryBoxModels(models)}
      modelsLoading={modelsLoading}
      showModelSelector={!binding.steers}
      dripStyles={drip.dripStyles}
      drippiness={drip.blur}
      pendingPriceLimitCents={a.pendingPriceLimitCents}
      onPendingPriceLimitChange={a.setPendingPriceLimitCents}
    />
  );
  return (
    <UserAppScreen
      key={view.key}
      view={view}
      onClose={onClose}
      onStartAgent={startAgent}
      renderQueryBox={renderQueryBox}
    />
  );
}

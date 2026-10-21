/**
 * STATE MACHINE: AppScreenHost (Rose Desktop app view inside the agents column)
 *
 * Stateless glue between the terminal and AppViewScreen
 * (terminal-component-group/components/app-view): it renders the normal query
 * box (same QueryInput; Popular Goals never mounted, no model choice since the
 * text goes to the code session) bound to the view's composer. Attachments and
 * text stay in the session draft until the delivery acknowledgement succeeds.
 */
import {
  AppViewScreen,
  QueryInput,
  type AppQueryBoxBinding,
  type AppViewTarget,
} from '@/features/terminal-component-group';

import type { AgentSlice, DripSlice } from '../types';

interface AppScreenHostProps {
  target: AppViewTarget;
  onClose: () => void;
  agents: AgentSlice;
  drip: DripSlice;
}

/** The full-screen app view with the normal query box (Popular Goals hidden). */
export function AppScreenHost({ target, onClose, agents: a, drip }: AppScreenHostProps) {
  const renderQueryBox = (binding: AppQueryBoxBinding) => (
    <QueryInput
      liftAboveApps
      directChannel
      draftKey={binding.draftKey}
      canSubmit
      value={binding.value}
      onChange={binding.onChange}
      onSubmit={binding.onSubmit}
      disabled={binding.disabled}
      placeholder={binding.placeholder}
      selectedModel={a.selectedModel}
      showModelSelector={false}
      dripStyles={drip.dripStyles}
      drippiness={drip.blur}
    />
  );
  return (
    <AppViewScreen
      key={target.taskId}
      target={target}
      onClose={onClose}
      renderQueryBox={renderQueryBox}
    />
  );
}

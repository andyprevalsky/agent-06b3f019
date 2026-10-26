/**
 * STATE MACHINE: ClaudeCodeChip
 *
 * EXPANSION STATE:
 * [COLLAPSED] <-- isExpanded: false
 *     |
 *     v
 * [EXPANDED] <-- isExpanded: true (shows terminal output)
 *
 * FULLSCREEN STATE:
 * [NORMAL] <-- isFullscreen: false
 *     |
 *     v
 * [FULLSCREEN] <-- isFullscreen: true (renders via portal)
 *
 * CHIP STATE (derived from agent messages + WS signals):
 * spinning_up -> live -> (verifying) -> (completed | failed)
 *
 * ROSE DESKTOP (flag on AND a `metadata.code_agent` snapshot for this task):
 * [DESKTOP] <-- DesktopCodeAgentChip (target label, timer, transcript (no
 *               terminal view), steer input, commit summary, paused state; see
 *               codeAgentChip.desktop.tsx). Maximize opens the code-agent view; no
 *               terminal and no saved-output read.
 * [DESKTOP, no snapshot] (older sessions) → status-only CollapsedChip: no terminal,
 *               no Maximize / fullscreen, no saved-output read; an ended simulated
 *               (WMH) session expands to its recorded result.
 * Flag off → the stock branches below, unchanged.
 *
 * All effects, refs, and sub-hooks live in `useClaudeCodeChip`. This file is a
 * presentational router: it picks one renderer branch per state.
 */

import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { desktopChipState, useDesktopCodeAgent } from '../hooks/codeAgentSteering';
import { type ClaudeCodeChipProps } from '../types';
import { useClaudeCodeChip, type ClaudeCodeChipVM } from './claudeCodeChip.hooks';
import { DesktopCodeAgentChip } from './codeAgentChip.desktop';
import {
  CollapsedChip,
  FullscreenView,
  LiveChip,
  SpinningUpChip,
} from './claudeCodeChip.renderers';

/**
 * Rose Desktop, a session without a snapshot: status only, never a terminal view.
 * A simulated (WMH) session's recorded result is no terminal: once it ended, the chip
 * expands to that recorded text (no real-session read).
 */
function DesktopStatusChip({ vm }: { vm: ClaudeCodeChipVM }) {
  const ended = vm.chipState === 'completed' || vm.chipState === 'failed';
  const recorded = ended ? vm.simulatedOutput : undefined;
  return (
    <CollapsedChip
      state={vm.chipState}
      isExpanded={vm.isExpanded}
      outputSchema={vm.outputSchema}
      structuredResponse={vm.structuredResponse}
      failureMessage={vm.failureMessage}
      githubRepoUrl={vm.githubRepoUrl}
      codeProvider={vm.codeProvider}
      terminalTranscript={recorded ?? ''}
      terminalContainerRef={vm.terminalContainerRef}
      onToggleExpand={vm.toggleExpand}
      terminal={recorded !== undefined}
    />
  );
}

export default function ClaudeCodeChip({
  taskId,
  wsUrl,
  codeProvider = 'claude',
  forceShow = false,
  toolCallId,
}: ClaudeCodeChipProps) {
  const roseDesktop = useRoseDesktop();
  const desktop = useDesktopCodeAgent(taskId, toolCallId);
  const desktopMeta = desktop.meta;
  // A Rose Desktop snapshot drives the chip and shows no terminal output: no terminal
  // WebSocket (an unbounded byte sink per live chip) and no saved-output read.
  const socket = desktopMeta === null ? wsUrl : undefined;
  const savedOutput = desktopMeta === null && !roseDesktop;
  const provider = desktopMeta?.provider ?? codeProvider;
  const vm = useClaudeCodeChip(taskId, socket, forceShow, provider, { savedOutput });

  if (vm.isFullscreen) {
    return (
      <FullscreenView
        state={desktopMeta ? desktopChipState(desktopMeta, vm.chipState) : vm.chipState}
        outputSchema={vm.outputSchema}
        githubRepoUrl={vm.githubRepoUrl}
        codeProvider={vm.codeProvider}
        terminalTranscript={vm.terminalTranscript}
        terminalContainerRef={vm.fullscreenContainerRef}
        onClose={vm.closeFullscreen}
      />
    );
  }

  if (desktopMeta) {
    return (
      <DesktopCodeAgentChip
        meta={desktopMeta}
        vm={vm}
        events={desktop.events}
        toolCallId={desktop.toolCallId}
      />
    );
  }

  if (roseDesktop) return <DesktopStatusChip vm={vm} />;

  if (vm.chipState === 'completed' || vm.chipState === 'failed') {
    return (
      <CollapsedChip
        state={vm.chipState}
        isExpanded={vm.isExpanded}
        outputSchema={vm.outputSchema}
        structuredResponse={vm.structuredResponse}
        failureMessage={vm.failureMessage}
        githubRepoUrl={vm.githubRepoUrl}
        codeProvider={vm.codeProvider}
        terminalTranscript={vm.terminalTranscript}
        terminalContainerRef={vm.terminalContainerRef}
        onToggleExpand={vm.toggleExpand}
        onMaximize={vm.openFullscreen}
      />
    );
  }

  if (vm.chipState === 'spinning_up') {
    return (
      <SpinningUpChip
        forceShow={forceShow}
        outputSchema={vm.outputSchema}
        githubRepoUrl={vm.githubRepoUrl}
        codeProvider={vm.codeProvider}
        terminalContainerRef={vm.terminalContainerRef}
        onMaximize={vm.openFullscreen}
      />
    );
  }

  return (
    <LiveChip
      state={vm.chipState}
      outputSchema={vm.outputSchema}
      githubRepoUrl={vm.githubRepoUrl}
      codeProvider={vm.codeProvider}
      terminalContainerRef={vm.terminalContainerRef}
      onMaximize={vm.openFullscreen}
    />
  );
}

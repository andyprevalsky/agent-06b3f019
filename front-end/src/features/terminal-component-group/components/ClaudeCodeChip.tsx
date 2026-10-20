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
 * [DESKTOP] <-- DesktopCodeAgentChip (target label, timer, Transcript/Terminal
 *               tabs, steer input, commit summary; see codeAgentChip.desktop.tsx)
 * Flag off, or no snapshot → the stock branches below, unchanged.
 *
 * All effects, refs, and sub-hooks live in `useClaudeCodeChip`. This file is a
 * presentational router: it picks one renderer branch per state.
 */

import { useDesktopCodeAgent } from '../hooks/codeAgentSteering';
import { type ClaudeCodeChipProps } from '../types';
import { useClaudeCodeChip } from './claudeCodeChip.hooks';
import { DesktopCodeAgentChip } from './codeAgentChip.desktop';
import {
  CollapsedChip,
  FullscreenView,
  LiveChip,
  SpinningUpChip,
} from './claudeCodeChip.renderers';

export default function ClaudeCodeChip({
  taskId,
  wsUrl,
  codeProvider = 'claude',
  forceShow = false,
}: ClaudeCodeChipProps) {
  const desktop = useDesktopCodeAgent(taskId);
  const desktopMeta = desktop.meta;
  // The desktop chip keeps its Terminal tab mounted while live, so the xterm
  // must attach even before the WS reports `live`.
  const vm = useClaudeCodeChip(
    taskId,
    wsUrl,
    forceShow || desktopMeta?.state === 'live',
    desktopMeta?.provider ?? codeProvider,
  );

  if (vm.isFullscreen) {
    return (
      <FullscreenView
        state={vm.chipState}
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

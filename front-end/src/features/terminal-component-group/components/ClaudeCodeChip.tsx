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
 * All effects, refs, and sub-hooks live in `useClaudeCodeChip`. This file is a
 * presentational router: it picks one renderer branch per state.
 */

import { type ClaudeCodeChipProps } from '../types';
import { useClaudeCodeChip } from './claudeCodeChip.hooks';
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
  const vm = useClaudeCodeChip(taskId, wsUrl, forceShow, codeProvider);

  if (vm.isFullscreen) {
    return (
      <FullscreenView
        state={vm.chipState}
        outputSchema={vm.outputSchema}
        githubRepoUrl={vm.githubRepoUrl}
        codeProvider={vm.codeProvider}
        turnCount={vm.turnCount}
        terminalTranscript={vm.terminalTranscript}
        terminalContainerRef={vm.fullscreenContainerRef}
        onClose={vm.closeFullscreen}
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
        turnCount={vm.turnCount}
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
        turnCount={vm.turnCount}
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
      turnCount={vm.turnCount}
      terminalContainerRef={vm.terminalContainerRef}
      onMaximize={vm.openFullscreen}
    />
  );
}

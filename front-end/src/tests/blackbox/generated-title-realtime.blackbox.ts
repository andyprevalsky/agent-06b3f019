import { describe, expect, it } from 'vitest';

import { overlaySelectedAgentTitle } from '@/features/terminal/hooks/useTerminalAgents';

import { makeTerminalHookAgent as makeAgent } from './terminal-hooks.fixtures';

describe('generated title realtime display', () => {
  it('overlays the selected agent title onto its sidebar row', () => {
    const sidebarAgent = makeAgent({ title: null });
    const selectedAgent = makeAgent({ title: 'Generated Agent Title' });

    const result = overlaySelectedAgentTitle([sidebarAgent], selectedAgent);

    expect(result[0]?.title).toBe('Generated Agent Title');
  });
});

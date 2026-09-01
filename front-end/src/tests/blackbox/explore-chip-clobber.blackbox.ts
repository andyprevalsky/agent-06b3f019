/**
 * Regression: resolving a chip by toolCallId must never silently delete a chip.
 *
 * Fixture is the UNMODIFIED prod transcript of agent
 * a6b8593a-bd41-4a18-8eca-667cbf0020ba's explore child. Three rows share
 * toolCallId 10a6cbd0: the tool's own formatted ERROR chip, its IN_PROGRESS
 * chip (persisted 23ms LATE, out of program order), and a third row written by
 * run_agent and relabelled `spawn_agent`. dedupByToolCallId was
 * last-arrival-wins over all three, so the tool's formatted chip vanished and
 * the user saw a bare `WebFetchProvidersFailed: …` blob attributed to the
 * sub-agent itself.
 *
 * The agent side no longer writes the third row and now orders posts per chip
 * (see the RCA), but the FE must not depend on every writer behaving — the same
 * clobber is still reachable from agent_workflow.py's main-path error post.
 *
 * See docs/rca/cases/2026-08-19-explore-fe-posts-race-into-last-write-wins-chip-id.md
 */

import { describe, expect, it } from 'vitest';

import type { Message } from '@/features/terminal-component-group/api';
import { deduplicateToolMessages } from '@/features/terminal-component-group/hooks/deduplicateToolMessages';

import prodTranscriptJson from './explore-chip-clobber-prod-a6b8593a.fixture.json';

const prodTranscript = prodTranscriptJson as unknown as Message[];

describe('tool chip resolution by toolCallId', () => {
  it("keeps a tool's own formatted chip when another writer reuses its toolCallId", () => {
    const [, stepMap] = deduplicateToolMessages(prodTranscript);
    const steps = Array.from(stepMap.values()).flat();

    const webFetchSteps = steps.filter((s) => s.toolName === 'web_fetch');
    expect(webFetchSteps).toHaveLength(1);

    const failure = webFetchSteps[0]!;
    // Terminal beats non-terminal: the late IN_PROGRESS must not win and strand
    // a spinner (cleanOrphanedInProgress exempts explore, so nothing reaps it).
    expect(failure.status).toBe('ERROR');
    // And it is the tool's OWN chip — URL-bearing title, formatted body — not
    // the bare exception string another writer posted at the same id.
    expect(failure.title).toContain('Web fetch failed for');
    expect(failure.message).toContain('**Params Passed:**');
    expect(failure.message.startsWith('WebFetchProvidersFailed:')).toBe(false);
  });

  it('still renders the explore agent final result as the bubble', () => {
    const [rendered] = deduplicateToolMessages(prodTranscript);
    const bubbles = rendered.filter((m) => m.metadata?.agentType === 'explore');

    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.text).toContain('Andy Prevalsky');
    expect(bubbles[0]?.metadata?.toolStatus).toBe('FINISHED');
  });

  it('prefers the later explore summary over a Fast Mode fire-and-track stub', () => {
    const taskId = 'task-huberman-explore';
    const messages: Message[] = [
      {
        message_id: 'explore-start',
        timestamp: '2026-08-28T00:00:00.000Z',
        role: 'TOOL',
        text: 'Research Andrew Huberman last 90 days',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'IN_PROGRESS',
          agentType: 'explore',
          taskId,
          title: 'Exploring',
          fullGoal: 'Research Andrew Huberman last 90 days',
        },
      },
      {
        message_id: 'explore-stub',
        timestamp: '2026-08-28T00:00:01.000Z',
        role: 'TOOL',
        text: 'Fast Mode parallel replay: explore started and will run its full cached trajectory before this agent completes.',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          agentType: 'explore',
          taskId,
          title: 'Research Andrew Huberman last 90 days',
          fullGoal: 'Research Andrew Huberman last 90 days',
          fastModeParallel: true,
        },
      },
      {
        message_id: 'explore-search',
        timestamp: '2026-08-28T00:00:02.000Z',
        role: 'TOOL',
        text: '**Result:** Huberman Lab channel stats',
        metadata: {
          toolCallId: 'tc-search',
          toolName: 'web_search',
          toolStatus: 'FINISHED',
          agentType: 'explore',
          taskId,
          title: 'Searched the web',
        },
      },
      {
        message_id: 'explore-summary',
        timestamp: '2026-08-28T00:00:10.000Z',
        role: 'TOOL',
        text: 'Huberman posts 3x/week on YouTube. Top hooks are protocol + mechanism.',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          agentType: 'explore',
          taskId,
          title: 'Research Andrew Huberman last 90 days',
          fullGoal: 'Research Andrew Huberman last 90 days',
        },
      },
    ];

    const [rendered] = deduplicateToolMessages(messages);
    const bubbles = rendered.filter((m) => m.metadata?.agentType === 'explore');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.text).toContain('Huberman posts 3x/week');
    expect(bubbles[0]?.text).not.toMatch(/fast\s*mode/i);
    expect(bubbles[0]?.text).not.toMatch(/cached trajectory/i);
  });

  it('shows the later explore summary over a Research started. fire-and-track stub', () => {
    const taskId = 'task-delauer-explore';
    const messages: Message[] = [
      {
        message_id: 'explore-start',
        timestamp: '2026-08-28T00:00:00.000Z',
        role: 'TOOL',
        text: 'Research Thomas DeLauer last 90 days',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'IN_PROGRESS',
          agentType: 'explore',
          taskId,
          title: 'Exploring',
          fullGoal: 'Research Thomas DeLauer last 90 days',
        },
      },
      {
        message_id: 'explore-stub',
        timestamp: '2026-08-28T00:00:01.000Z',
        role: 'TOOL',
        text: 'Research started.',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          agentType: 'explore',
          taskId,
          title: 'Research Thomas DeLauer last 90 days',
          fullGoal: 'Research Thomas DeLauer last 90 days',
          fastModeParallel: true,
        },
      },
      {
        message_id: 'explore-summary',
        timestamp: '2026-08-28T00:00:12.000Z',
        role: 'TOOL',
        text: '## (1) Thomas DeLauer — 90-day cadence\nPosts ~4x/week. Hooks are fasting + training.',
        metadata: {
          toolCallId: 'tc-explore',
          toolName: 'spawn_agent',
          toolStatus: 'FINISHED',
          agentType: 'explore',
          taskId,
          title: 'Research Thomas DeLauer last 90 days',
          fullGoal: 'Research Thomas DeLauer last 90 days',
        },
      },
    ];

    const [rendered] = deduplicateToolMessages(messages);
    const bubbles = rendered.filter((m) => m.metadata?.agentType === 'explore');
    expect(bubbles).toHaveLength(1);
    expect(bubbles[0]?.text).toContain('Thomas DeLauer — 90-day cadence');
    expect(bubbles[0]?.text).not.toMatch(/research started/i);
  });
});

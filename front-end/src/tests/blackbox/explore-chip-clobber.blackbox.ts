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
});

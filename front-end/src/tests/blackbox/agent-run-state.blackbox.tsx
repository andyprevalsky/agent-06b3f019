/**
 * Blackbox tests for the sidebar's three-state run indicator.
 *
 * Covers the pure status derivation (agentRunState) and the rendered indicator,
 * including the two rules that are easy to regress:
 *   - only the active state animates
 *   - needs-help outranks the raw status, and archived outranks everything
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import AgentStatusIndicator from '@/features/terminal-component-group/components/AgentStatusIndicator';
import {
  agentRunStatus,
  isAgentActive,
} from '@/features/terminal-component-group/components/agentRunState';
import {
  elapsedSince,
  elapsedTickIntervalMs,
  formatElapsed,
} from '@/features/terminal-component-group/components/formatElapsed';
import {
  BUILD_FRAMES,
  COMPLETE_FRAME,
  CYCLE_FRAMES,
  ERASE_FRAMES,
  HOLD_FRAMES,
  DIAGONAL_COUNT,
  FRAMES_PER_LETTER,
  LETTER_NAMES,
  cellOpacity,
  diagonalOf,
  letterIndexForFrame,
  letterMask,
  phaseOffsetFor,
  resetLetterPhaseForTests,
} from '@/features/terminal-component-group/components/roseDotLetters';
import type { Agent } from '@/lib/api';

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    goal: 'A test goal',
    title: null,
    pinned_at: null,
    model: 'rose-1-lite',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.25,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: null,
    token_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: 0,
    price_limit_cents: 100,
    tree_cost_cents: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    write_lock_enabled: false,
    ...overrides,
  };
}

describe('agentRunStatus', () => {
  it('maps in-flight statuses to active', () => {
    for (const status of ['STARTING_UP', 'ACTIVE'] as const) {
      const result = agentRunStatus(makeAgent({ status }));
      expect(result.state).toBe('active');
      expect(result.label).toBe('Working');
    }
  });

  it('folds out-of-credits, cost-limit and paused into needs-help', () => {
    const cases = [
      ['OUT_OF_CREDITS', 'out-of-credits', 'Out of credits'],
      ['COST_LIMIT_REACHED', 'cost-limit', 'Cost limit reached'],
      ['PAUSED', 'paused', 'Paused'],
    ] as const;

    for (const [status, reason, label] of cases) {
      const result = agentRunStatus(makeAgent({ status }));
      expect(result.state).toBe('needs-help');
      expect(result.reason).toBe(reason);
      expect(result.label).toBe(label);
    }
  });

  it('maps terminal statuses to done, distinguishing failure', () => {
    expect(agentRunStatus(makeAgent({ status: 'COMPLETED' }))).toMatchObject({
      state: 'done',
      failed: false,
    });
    expect(agentRunStatus(makeAgent({ status: 'FAILED' }))).toMatchObject({
      state: 'done',
      failed: true,
    });
  });

  it('lets an unanswered attention request outrank an ACTIVE status', () => {
    const agent = makeAgent({ status: 'ACTIVE' });
    expect(agentRunStatus(agent).state).toBe('active');

    const blocked = agentRunStatus(agent, { hasAttentionRequest: true });
    expect(blocked.state).toBe('needs-help');
    expect(blocked.reason).toBe('attention');
  });

  it('forces archived rows terminal even when the status is still ACTIVE', () => {
    // Archiving terminates the workflow but leaves `status` as the record of how
    // the run ended, so this row would otherwise animate forever.
    const result = agentRunStatus(makeAgent({ status: 'ACTIVE' }), { isArchived: true });
    expect(result.state).toBe('done');
    expect(result.label).toBe('Archived');
  });

  it('archived outranks an outstanding attention request', () => {
    const result = agentRunStatus(makeAgent({ status: 'ACTIVE' }), {
      isArchived: true,
      hasAttentionRequest: true,
    });
    expect(result.state).toBe('done');
  });

  it('isAgentActive tracks the active state', () => {
    expect(isAgentActive(makeAgent({ status: 'ACTIVE' }))).toBe(true);
    expect(isAgentActive(makeAgent({ status: 'ACTIVE' }), { hasAttentionRequest: true })).toBe(
      false,
    );
    expect(isAgentActive(makeAgent({ status: 'COMPLETED' }))).toBe(false);
  });
});

describe('AgentStatusIndicator', () => {
  it('renders the ROSE dot matrix ONLY for the active state', () => {
    const { container: active } = render(
      <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} />,
    );
    expect(active.querySelectorAll('[data-letter] > span')).toHaveLength(25);

    for (const status of ['PAUSED', 'OUT_OF_CREDITS', 'COMPLETED', 'FAILED'] as const) {
      const { container } = render(
        <AgentStatusIndicator status={agentRunStatus(makeAgent({ status }))} />,
      );
      expect(container.querySelector('[data-letter]')).toBeNull();
    }
  });

  it('starts the cycle on a correctly-shaped R', () => {
    const { container } = render(
      <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} />,
    );
    expect(container.querySelector('[data-letter]')?.getAttribute('data-letter')).toBe('R');

    // Assert the bitmap itself rather than the rendered opacities: mid-build,
    // most of the letter is legitimately still invisible.
    const expected = ['11110', '10010', '11110', '10100', '10010'].flatMap((row) =>
      Array.from(row, (c) => c === '1'),
    );
    expect(letterMask(0)).toEqual(expected);
  });

  it('draws a letter in one diagonal at a time from the top-left', () => {
    // Frame 0: only the corner diagonal has begun, at the first ramp step.
    expect(cellOpacity(true, 0, 0)).toBe(0.25);
    expect(cellOpacity(true, 1, 0)).toBe(0);
    expect(cellOpacity(true, 8, 0)).toBe(0);

    // Frame 3: the corner is full, and the diagonals behind it trail it by one
    // ramp step each — that stagger IS the sweep.
    expect(cellOpacity(true, 0, 3)).toBe(1);
    expect(cellOpacity(true, 1, 3)).toBe(0.75);
    expect(cellOpacity(true, 2, 3)).toBe(0.5);
    expect(cellOpacity(true, 3, 3)).toBe(0.25);
    expect(cellOpacity(true, 4, 3)).toBe(0);
  });

  it('ramps every diagonal 0 -> 0.25 -> 0.5 -> 0.75 -> 1 and then holds', () => {
    const d = 4;
    expect(cellOpacity(true, d, d - 1)).toBe(0);
    expect([0, 1, 2, 3].map((k) => cellOpacity(true, d, d + k))).toEqual([0.25, 0.5, 0.75, 1]);
    // Stays full for the whole hold window — it must not creep back down before
    // the erase officially starts.
    for (let f = COMPLETE_FRAME; f < BUILD_FRAMES + HOLD_FRAMES; f += 1) {
      expect(cellOpacity(true, d, f)).toBe(1);
    }
  });

  it('has the whole letter at full opacity exactly when the build completes', () => {
    for (let diagonal = 0; diagonal < DIAGONAL_COUNT; diagonal += 1) {
      expect(cellOpacity(true, diagonal, COMPLETE_FRAME)).toBe(1);
    }
    // One frame earlier the last diagonal is NOT yet full — otherwise the hold
    // would start before the drawing had finished.
    expect(cellOpacity(true, DIAGONAL_COUNT - 1, COMPLETE_FRAME - 1)).toBeLessThan(1);
    // And the hold is real: frames remain after completion.
    expect(FRAMES_PER_LETTER).toBeGreaterThan(BUILD_FRAMES);
  });

  it('erases as a mirror of the draw: last diagonal in is first out', () => {
    const eraseStart = BUILD_FRAMES + HOLD_FRAMES;

    // The bottom-right diagonal — the last to arrive — begins leaving first,
    // while the top-left corner is still at full.
    expect(cellOpacity(true, DIAGONAL_COUNT - 1, eraseStart)).toBe(0.75);
    expect(cellOpacity(true, 0, eraseStart)).toBe(1);

    // ...and the corner is the last thing standing near the end.
    const nearEnd = eraseStart + ERASE_FRAMES - 2;
    expect(cellOpacity(true, 0, nearEnd)).toBeGreaterThan(0);
    expect(cellOpacity(true, DIAGONAL_COUNT - 1, nearEnd)).toBe(0);
  });

  it('ramps the erase back down 1 -> 0.75 -> 0.5 -> 0.25 -> 0', () => {
    const eraseStart = BUILD_FRAMES + HOLD_FRAMES;
    // Diagonal 8 is mirrored to position 0, so it leads the erase.
    const seen = [0, 1, 2, 3].map((k) => cellOpacity(true, DIAGONAL_COUNT - 1, eraseStart + k));
    expect(seen).toEqual([0.75, 0.5, 0.25, 0]);
  });

  it('ends every cycle on a completely empty grid', () => {
    // No dot may survive into the next letter, or two letters would overlap.
    for (let diagonal = 0; diagonal < DIAGONAL_COUNT; diagonal += 1) {
      expect(cellOpacity(true, diagonal, FRAMES_PER_LETTER - 1)).toBe(0);
    }
  });

  it('is symmetric: the erase takes exactly as long as the draw', () => {
    expect(ERASE_FRAMES).toBe(BUILD_FRAMES);
    expect(FRAMES_PER_LETTER).toBe(BUILD_FRAMES + HOLD_FRAMES + ERASE_FRAMES);
  });

  it('keeps dots outside the letterform fully transparent', () => {
    expect(cellOpacity(false, 0, 0)).toBe(0);
    expect(cellOpacity(false, 0, BUILD_FRAMES)).toBe(0);
    expect(cellOpacity(false, 4, FRAMES_PER_LETTER)).toBe(0);
  });

  it('maps cell index to its (row + col) diagonal', () => {
    expect(diagonalOf(0)).toBe(0);
    expect(diagonalOf(4)).toBe(4);
    expect(diagonalOf(20)).toBe(4);
    expect(diagonalOf(24)).toBe(DIAGONAL_COUNT - 1);
  });

  it('advances to the next letter only after the hold', () => {
    expect(letterIndexForFrame(0)).toBe(0);
    expect(letterIndexForFrame(FRAMES_PER_LETTER - 1)).toBe(0);
    expect(letterIndexForFrame(FRAMES_PER_LETTER)).toBe(1);
    expect(letterIndexForFrame(FRAMES_PER_LETTER * 3)).toBe(3);
    // Wraps back to R rather than running past E.
    expect(letterIndexForFrame(FRAMES_PER_LETTER * 4)).toBe(0);
  });

  it('cycles R -> O -> S -> E', () => {
    expect(LETTER_NAMES).toEqual(['R', 'O', 'S', 'E']);
    const masks = [0, 1, 2, 3].map((phase) => letterMask(phase));
    // Every letter is a distinct glyph — a duplicated bitmap would make the
    // cycle silently stutter.
    expect(new Set(masks.map((m) => m.map(Number).join(''))).size).toBe(4);
    masks.forEach((m) => expect(m).toHaveLength(25));
  });

  it('wraps the phase rather than running off the end of the alphabet', () => {
    expect(letterMask(4)).toEqual(letterMask(0));
    expect(letterMask(-1)).toEqual(letterMask(3));
  });

  it('names each state for assistive tech', () => {
    render(<AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} />);
    expect(screen.getByLabelText('Working')).toBeTruthy();

    render(
      <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'OUT_OF_CREDITS' }))} />,
    );
    expect(screen.getByLabelText('Out of credits')).toBeTruthy();

    render(<AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'COMPLETED' }))} />);
    expect(screen.getByLabelText('Completed')).toBeTruthy();
  });

  it('freezes on R when the user asked for reduced motion', () => {
    // Switching letters IS motion, so honouring the preference means never
    // starting the clock — not merely slowing it.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;

    try {
      resetLetterPhaseForTests();
      const { container } = render(
        <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} />,
      );
      expect(container.querySelector('[data-letter]')?.getAttribute('data-letter')).toBe('R');
      // A COMPLETED R, not a half-drawn one: every lit cell sits at full opacity
      // so the state stays legible by shape without any motion.
      const dots = Array.from(container.querySelectorAll<HTMLElement>('[data-letter] > span'));
      expect(dots).toHaveLength(25);
      const litOpacities = letterMask(0)
        .map((lit, i) => (lit ? dots[i].style.opacity : null))
        .filter((o): o is string => o !== null);
      expect(new Set(litOpacities)).toEqual(new Set(['1']));
    } finally {
      window.matchMedia = original;
      resetLetterPhaseForTests();
    }
  });
});

describe('animation desync', () => {
  it('gives different agents different phase offsets', () => {
    const ids = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'agent-007', 'zzz'];
    const offsets = ids.map(phaseOffsetFor);
    // Not a strict guarantee for arbitrary input, but for a realistic spread of
    // ids a hash that collapsed everything to one value would put the whole
    // sidebar back in lockstep — which is the bug this guards.
    expect(new Set(offsets).size).toBeGreaterThan(ids.length / 2);
  });

  it('keeps an agent phase stable across calls', () => {
    // Must not be randomised: a row whose animation jumped on every refetch
    // would be worse than perfect sync.
    expect(phaseOffsetFor('stable-agent-id')).toBe(phaseOffsetFor('stable-agent-id'));
  });

  it('keeps every offset inside the cycle', () => {
    for (const id of ['', 'a', 'a-very-long-agent-identifier-0123456789', '💥']) {
      const offset = phaseOffsetFor(id);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(CYCLE_FRAMES);
      expect(Number.isInteger(offset)).toBe(true);
    }
  });

  it('renders neighbouring rows on different letters', () => {
    // Two rows, same status, same clock — they must not draw in unison.
    const { container } = render(
      <>
        <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} seed="a1" />
        <AgentStatusIndicator status={agentRunStatus(makeAgent({ status: 'ACTIVE' }))} seed="b2" />
      </>,
    );
    const letters = Array.from(container.querySelectorAll('[data-letter]')).map((el) =>
      el.getAttribute('data-letter'),
    );
    expect(letters).toHaveLength(2);
    expect(phaseOffsetFor('a1')).not.toBe(phaseOffsetFor('b2'));
  });
});

describe('formatElapsed', () => {
  const S = 1000;
  const M = 60 * S;
  const H = 60 * M;
  const D = 24 * H;

  it('formats sub-minute runs in seconds', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45 * S)).toBe('45s');
    expect(formatElapsed(59.9 * S)).toBe('59s');
  });

  it('formats sub-hour runs in whole minutes', () => {
    expect(formatElapsed(M)).toBe('1m');
    expect(formatElapsed(4 * M)).toBe('4m');
    expect(formatElapsed(59 * M + 59 * S)).toBe('59m');
  });

  it('formats sub-day runs in whole hours so the sidebar time stays on one line', () => {
    expect(formatElapsed(H)).toBe('1h');
    expect(formatElapsed(3 * H + 20 * M)).toBe('3h');
    expect(formatElapsed(23 * H + 59 * M)).toBe('23h');
  });

  it('formats multi-day runs in days and hours', () => {
    expect(formatElapsed(D)).toBe('1d');
    expect(formatElapsed(2 * D + 4 * H)).toBe('2d 4h');
    expect(formatElapsed(6 * D + 23 * H)).toBe('6d 23h');
  });

  it('drops hours past a week, where they are noise', () => {
    expect(formatElapsed(7 * D)).toBe('7d');
    expect(formatElapsed(12 * D + 9 * H)).toBe('12d');
  });

  it('clamps negative elapsed from client/server clock skew', () => {
    expect(formatElapsed(-5 * S)).toBe('0s');
  });

  it('slows the tick as a run ages so old rows stop re-rendering', () => {
    expect(elapsedTickIntervalMs(30 * S)).toBe(S);
    expect(elapsedTickIntervalMs(10 * M)).toBe(30 * S);
    expect(elapsedTickIntervalMs(3 * D)).toBe(5 * M);
  });

  it('treats an unparseable timestamp as zero rather than NaN', () => {
    expect(elapsedSince('not-a-date', Date.now())).toBe(0);
    expect(formatElapsed(elapsedSince('not-a-date', Date.now()))).toBe('0s');
  });
});

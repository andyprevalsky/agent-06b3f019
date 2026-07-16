/**
 * Blackbox reproduction: spawn sub-agent tree is INVISIBLE until refresh.
 *
 * BUG (confirmed): when a spawn message renders a sub-agent tree, the tree
 * renders NOTHING until the user refreshes the page.
 *
 * Root-cause chain (see docs/plans + SubAgentTree.tsx:59):
 *   - SubAgentTree returns `null` when `rootNodes.length === 0`.
 *   - `rootNodes` is built by `useSubAgentTreeData(busId, subAgentIds)` by
 *     looking up each id in the node map from `useAgentTree(busId)`.
 *   - `useAgentTree` fills that map from TWO decoupled sources: a one-shot REST
 *     snapshot `fetchTreeState(busId)` and live Supabase bus events.
 *   - At spawn time the REST snapshot is EMPTY (sub-agent rows just created) and
 *     if the bus events are missed/late, the node map stays empty.
 *   - Net: message metadata carries valid `subAgentIds` + `busId`, but the node
 *     map is empty -> `rootNodes = []` -> `return null` -> INVISIBLE tree.
 *
 * This test recreates that exact situation: `fetchTreeState` resolves to `[]`
 * and `subscribeToBus` delivers no nodes. It asserts the DESIRED (post-fix)
 * behavior — that a non-empty `subAgentIds` array yields SOME visible
 * sub-agent tree UI — so it FAILS on today's buggy code (which renders null).
 *
 * Test-only: no production files are modified.
 */
import { describe, it, expect, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';

// ── Mocks (hoisted before the module-under-test imports) ─────────────────────

// REST snapshot returns nothing — the sub-agent rows were just created and the
// backend tree endpoint has not caught up yet (the pre-refresh state).
vi.mock('@/lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...mod,
    fetchTreeState: vi.fn().mockResolvedValue([]),
  };
});

// Realtime bus joins successfully but delivers no AGENT_STATE_CHANGED events,
// so no nodes ever arrive via the live path either.
vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToBus: vi.fn().mockResolvedValue({ state: 'joined', topic: 'bus' } as never),
    unsubscribe: vi.fn(),
  };
});

import SubAgentTree from '@/features/terminal-component-group/components/SubAgentTree';
import { fetchTreeState } from '@/lib/api';

describe('SubAgentTree — spawn tree visibility before refresh', () => {
  it('shows sub-agent tree UI when subAgentIds are known but the node map is empty', async () => {
    const busId = 'bus-root-1';
    const subAgentIds = ['sub-agent-a', 'sub-agent-b'];

    const { container } = renderWithProviders(
      <SubAgentTree busId={busId} subAgentIds={subAgentIds} onNavigate={vi.fn()} />,
    );

    // Let the async REST snapshot (fetchTreeState -> []) and bus subscribe
    // effects settle so the component has fully re-rendered in its empty-map
    // state — exactly what the user sees at spawn time before refreshing.
    await waitFor(() => {
      expect(vi.mocked(fetchTreeState)).toHaveBeenCalled();
    });

    // DESIRED behavior: a non-empty spawn (2 known sub-agent ids) must render
    // SOMETHING the user can see — a container / skeleton / pending node — not
    // nothing. On today's buggy code SubAgentTree returns null, so the DOM is
    // empty and this assertion fails, reproducing the "invisible until refresh"
    // bug.
    expect(container).not.toBeEmptyDOMElement();
  });
});

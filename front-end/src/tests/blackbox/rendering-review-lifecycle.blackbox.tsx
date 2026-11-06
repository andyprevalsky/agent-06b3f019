import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLifecyclePatches,
  UI_LIFECYCLE_PATCHES,
} from '../../../scripts/patch-ui-lifecycle.mjs';
import { useMessageListProjection } from '@/features/terminal-component-group/components/useMessageListProjection';
import { groupAgentExchanges } from '@/features/terminal-component-group/components/agentExchangeGroups';
import { EMPTY_WEB_SEARCH_GROUPING } from '@/features/terminal-component-group/components/webSearchTurnGroups';
import { RoseDesktopContext } from '@/hooks/roseDesktopContext';
import { msg } from './code-agent-steering.fixtures';
const temporary: string[] = [];
const pristine = `const removeUnlinkedScrollListenerRef = React2.useRef(void 0);
        viewport.addEventListener("scroll", handleScroll);
        return () => viewport.removeEventListener("scroll", handleScroll);
      }
    }, [scrollAreaContext.viewport, debounceScrollEnd, onThumbPositionChange]);`;
const patches = UI_LIFECYCLE_PATCHES.filter(({ name }) => name === '@radix-ui/react-scroll-area');
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'rose-review-link-'));
  temporary.push(root);
  return root;
}
function install(root: string) {
  const directory = join(root, 'node_modules/@radix-ui/react-scroll-area');
  mkdirSync(join(directory, 'dist'), { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name: '@radix-ui/react-scroll-area',
      version: '1.3.0',
      main: 'dist/index.js',
    }),
  );
  for (const entry of ['index.js', 'index.mjs'])
    writeFileSync(join(directory, 'dist', entry), pristine);
  return directory;
}
const withRoseDesktop = ({ children }: { children: ReactNode }) =>
  createElement(RoseDesktopContext.Provider, { value: true }, children);
function exchange(i: number) {
  return msg(
    {
      a2a: {
        message_id: `e-${i}`,
        from: { id: 'root', kind: 'agent', label: 'root' },
        to: { id: 'worker', kind: 'agent', label: 'worker' },
        kind: 'message',
        text: `exchange ${i}`,
      },
    },
    { message_id: `row-${i}`, role: 'USER', timestamp: '2026-11-03T00:00:00Z' },
  );
}
function options(
  messages: ReturnType<typeof exchange>[],
  groups?: ReturnType<typeof groupAgentExchanges>,
) {
  return {
    filteredMessages: messages,
    groupAgentMessages: true,
    compressWork: false,
    agentExchangeGroups: groups,
    webSearchGrouping: EMPTY_WEB_SEARCH_GROUPING,
    currentAnimatingId: null as string | null,
    onAnimationComplete: vi.fn(),
  };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const p of temporary.splice(0)) rmSync(p, { recursive: true, force: true });
});
describe('actual lifecycle package discovery with local npm links', () => {
  it.each(['local-development', '@development/local'])(
    'repairs the real target while preserving unrelated external link %s',
    (name) => {
      const root = workspace(),
        target = install(root),
        foreign = workspace();
      writeFileSync(join(foreign, 'sentinel'), 'outside untouched');
      const link = join(root, 'node_modules', name);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(foreign, link, 'dir');
      expect(applyLifecyclePatches(patches, [root])).toEqual({ checked: 2, changed: 2 });
      expect(readFileSync(join(foreign, 'sentinel'), 'utf8')).toBe('outside untouched');
      expect(readFileSync(join(target, 'dist/index.js'), 'utf8')).not.toBe(pristine);
      expect(applyLifecyclePatches(patches, [root])).toEqual({ checked: 2, changed: 0 });
    },
  );
  it('rejects an escaping frontend module root before repairing a local fallback', () => {
    const root = workspace(),
      front = join(root, 'front-end'),
      foreign = workspace();
    mkdirSync(front);
    writeFileSync(join(front, 'package.json'), '{}');
    const local = install(root),
      external = install(foreign);
    symlinkSync(join(foreign, 'node_modules'), join(front, 'node_modules'), 'dir');
    expect(createRequire(join(front, 'package.json')).resolve('@radix-ui/react-scroll-area')).toBe(
      join(external, 'dist/index.js'),
    );
    expect(() => applyLifecyclePatches(patches, [front, root])).toThrow('outside');
    expect(readFileSync(join(local, 'dist/index.js'), 'utf8')).toBe(pristine);
    expect(readFileSync(join(external, 'dist/index.js'), 'utf8')).toBe(pristine);
  });
  it('still rejects a target escaping the workspace before patching any valid copy', () => {
    const root = workspace(),
      local = install(root),
      foreign = install(workspace());
    const scope = join(root, 'node_modules/consumer/node_modules/@radix-ui');
    mkdirSync(scope, { recursive: true });
    symlinkSync(foreign, join(scope, 'react-scroll-area'), 'dir');
    expect(() => applyLifecyclePatches(patches, [root])).toThrow('outside');
    expect(readFileSync(join(local, 'dist/index.js'), 'utf8')).toBe(pristine);
    expect(readFileSync(join(foreign, 'dist/index.js'), 'utf8')).toBe(pristine);
  });
});
describe('provided exchange projection ownership at the real list hook', () => {
  it('does not repeat timestamp projection after a genuine 10001st history insertion', () => {
    let reads = 0;
    const rows = Array.from({ length: 10000 }, (_, i) => {
      const row = exchange(i),
        time = row.timestamp;
      Object.defineProperty(row, 'timestamp', {
        get() {
          reads++;
          return time;
        },
      });
      return row;
    });
    const initial = options(rows, groupAgentExchanges(rows));
    const view = renderHook(useMessageListProjection, {
      initialProps: initial,
      wrapper: withRoseDesktop,
    });
    const next = [...rows, exchange(10000)];
    const supplied = groupAgentExchanges(next);
    reads = 0;
    view.rerender(options(next, supplied));
    expect(view.result.current.renderedMessages.map((x) => x.message_id)).toEqual(['row-0']);
    expect(reads).toBe(0);
  });
  it('completes a supplied folded animation once without installing another periodic clock', () => {
    vi.useFakeTimers();
    const interval = vi.spyOn(globalThis, 'setInterval'),
      rows = [exchange(0), exchange(1)];
    const input = { ...options(rows, groupAgentExchanges(rows)), currentAnimatingId: 'row-1' };
    const view = renderHook(useMessageListProjection, {
      initialProps: input,
      wrapper: withRoseDesktop,
    });
    expect(input.onAnimationComplete).toHaveBeenCalledTimes(1);
    view.rerender({ ...input });
    expect(input.onAnimationComplete).toHaveBeenCalledTimes(1);
    expect(interval).not.toHaveBeenCalled();
  });
  it('preserves fallback clock/completion and disabled grouping semantics', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1700000000000);
    const rows = [exchange(0), exchange(1)];
    const input = { ...options(rows), currentAnimatingId: 'row-1' };
    const view = renderHook(useMessageListProjection, {
      initialProps: input,
      wrapper: withRoseDesktop,
    });
    expect(input.onAnimationComplete).toHaveBeenCalledTimes(1);
    const now = view.result.current.localExchanges.now;
    act(() => vi.advanceTimersByTime(10000));
    expect(view.result.current.localExchanges.now).toBe(now + 10000);
    const complete = vi.fn();
    view.rerender({
      ...input,
      groupAgentMessages: false,
      onAnimationComplete: complete,
      agentExchangeGroups: groupAgentExchanges(rows),
    });
    expect(complete).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

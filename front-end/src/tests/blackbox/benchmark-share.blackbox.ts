import { afterEach, expect, it } from 'vitest';
import { benchmarkShareToken, captureBenchmarkShareToken } from '@/lib/benchmarkShare';

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

it('removes the bearer query before analytics while keeping the current entry readable', () => {
  window.history.replaceState(
    { existing: 'router-state' },
    '',
    '/?agent-id=shared-agent&benchmark-share=secret-token&other=kept#transcript',
  );

  captureBenchmarkShareToken();

  expect(window.location.search).toBe('?agent-id=shared-agent&other=kept');
  expect(window.location.hash).toBe('#transcript');
  expect(window.history.state.existing).toBe('router-state');
  expect(benchmarkShareToken()).toBe('secret-token');

  window.history.replaceState(window.history.state, '', '/?agent-id=sibling-agent');
  expect(benchmarkShareToken()).toBe('secret-token');

  window.history.pushState({}, '', '/?agent-id=shared-agent');
  expect(benchmarkShareToken()).toBeNull();
});

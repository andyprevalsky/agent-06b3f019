import { expect, it } from 'vitest';
import type { Message } from '@/features/terminal-component-group/hooks';
import { latestBrowserActualModel } from '@/features/terminal-component-group/components/rose-apps/browserActualModel';
import { latestBrowserPageUrl } from '@/features/terminal-component-group/components/rose-apps/browserPageUrl';

function row(task: string, timestamp: string, value: string): Message {
  return {
    message_id: value,
    role: 'TOOL',
    text: '',
    timestamp,
    metadata: {
      task_id: task,
      auxiliary: { current_url: `https://${value}.example/`, actual_model: value },
    },
  };
}
it('keeps the newest observed URL and model when older events arrive after hydration', () => {
  const rows = [
    row('selected', '2026-10-21T12:02:00Z', 'newest'),
    row('selected', '2026-10-21T12:00:00Z', 'replayed'),
    row('sibling', '2026-10-21T12:05:00Z', 'foreign'),
  ];
  expect(latestBrowserPageUrl(rows, 'selected')).toBe('https://newest.example/');
  expect(latestBrowserActualModel(rows, 'selected')).toBe('newest');
});
it('uses a stable last-row fallback only when no matching observation has a valid timestamp', () => {
  const rows = [row('selected', '', 'first'), row('selected', 'invalid', 'fallback')];
  expect(latestBrowserPageUrl(rows, 'selected')).toBe('https://fallback.example/');
  expect(latestBrowserActualModel(rows, 'selected')).toBe('fallback');
  rows.unshift(row('selected', '2026-10-21T12:02:00Z', 'dated'));
  expect(latestBrowserPageUrl(rows, 'selected')).toBe('https://dated.example/');
  expect(latestBrowserActualModel(rows, 'selected')).toBe('dated');
});

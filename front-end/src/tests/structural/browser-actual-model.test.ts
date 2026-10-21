import { expect, it } from 'vitest';
import type { Message } from '@/features/terminal-component-group/hooks';
import { latestBrowserActualModel } from '@/features/terminal-component-group/components/rose-apps/browserActualModel';

const row = (task: string, model: unknown) =>
  ({
    role: 'TOOL',
    metadata: { task_id: task, auxiliary: { actual_model: model } },
  }) as Message;

it('takes the latest authoritative model only from the selected browser task', () => {
  expect(
    latestBrowserActualModel(
      [
        row('selected', 'first'),
        row('selected', 'browser-decision-model'),
        row('sibling', 'other-model'),
      ],
      'selected',
    ),
  ).toBe('browser-decision-model');
});
it('does not infer a model from provider family or empty metadata', () => {
  expect(
    latestBrowserActualModel(
      [
        row('selected', null),
        row('selected', '  '),
        { role: 'TOOL', metadata: { task_id: 'selected', is_claude: true } } as Message,
      ],
      'selected',
    ),
  ).toBeNull();
});

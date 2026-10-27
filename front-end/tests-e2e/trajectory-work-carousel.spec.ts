/** Real app rendering: arrivals replace one row; only compressed work exposes history. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
const OWNER = 'carousel-owner';
test('comms → work → comms → work stays one live line, then expands in order', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const user = { id: 'carousel-viewer', is_anonymous: false };
    localStorage.setItem('app-user', JSON.stringify(user));
    localStorage.setItem(
      'rose-session',
      JSON.stringify({
        user,
        access_token: 'fixture',
        refresh_token: 'fixture',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    );
  });
  let stage = 0;
  const start = Date.now() - 1000;
  const phases = ['Coordinate first', 'Read source files', 'Coordinate second', 'Run final checks'];
  const messages = phases.map((text, index) => ({
    message_id: `activity-${index}`,
    timestamp: new Date(start + index * 1000).toISOString(),
    role: index % 2 ? 'TOOL' : 'USER',
    text,
    metadata:
      index % 2
        ? {
            toolName: 'read_file',
            toolCallId: `call-${index}`,
            title: text,
            toolStatus: 'FINISHED',
          }
        : {
            a2a: {
              message_id: `exchange-${index}`,
              kind: 'message',
              from: { id: OWNER, kind: 'agent', label: 'Rose' },
              to: { id: 'worker', kind: 'agent', label: 'Worker' },
              text,
            },
          },
  }));
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
    const agent = {
      agent_id: OWNER,
      goal: 'Coordinate and check',
      model: 'rose-1-flash',
      source: 'WEB',
      reasoning_effort: 'medium',
      progress: stage * 25,
      status: stage === 5 ? 'COMPLETED' : 'ACTIVE',
      created_at: new Date(start).toISOString(),
      updated_at: new Date(start + stage * 1000).toISOString(),
      parent_agent_id: null,
      tools: [],
      context_size: 0,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      message_count: stage + 2,
      price_limit_cents: 100,
      tree_cost_cents: 0,
    };
    let body: unknown = {};
    if (path === '/api/agents') body = { agents: [agent] };
    else if (path === `/api/agents/${OWNER}`)
      body = {
        agent,
        pagination: { has_more: false, oldest_timestamp: null },
        messages: [
          {
            message_id: 'human',
            timestamp: new Date(start - 1000).toISOString(),
            role: 'USER',
            text: 'Coordinate and check',
          },
          ...messages
            .slice(0, Math.min(4, stage + 1))
            .flatMap((message) =>
              message.metadata.a2a
                ? [
                    message,
                    { ...message, message_id: `mirror-${message.message_id}`, role: 'TOOL' },
                  ]
                : [message],
            ),
          ...(stage >= 4
            ? [
                {
                  message_id: 'final',
                  timestamp: new Date(start + 4000).toISOString(),
                  role: 'TOOL',
                  text: 'Ready for review',
                  metadata: {
                    toolName: 'completion_summary',
                    toolStatus: 'FINISHED',
                    isFinalSummary: true,
                    completionSummary: {
                      summary: 'Ready for review',
                      outputs: [],
                      toolUsage: [],
                      totalToolCalls: 2,
                      durationSeconds: 4,
                      costDollars: 0,
                    },
                  },
                },
              ]
            : []),
        ],
      };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    await route.fulfill({ json: body });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${FRONTEND_URL}/?agent-id=${OWNER}&no-auto-login`, {
    waitUntil: 'domcontentloaded',
  });
  const row = page.getByTestId('trajectory-work-group');
  const line = page.getByTestId('trajectory-activity-line');
  let key: string | null = null;
  let height: number | undefined;
  for (let index = 0; index < 4; index++) {
    stage = index;
    await expect(line).toHaveText(index % 2 ? phases[index] : `Rose → Worker · ${phases[index]}`, {
      timeout: 20000,
    });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('trajectory-work-history')).toHaveCount(0);
    const current = await row.boundingBox();
    expect(current!.height).toBeLessThanOrEqual(48);
    if (height !== undefined) expect(current!.height).toBe(height);
    if (key !== null) expect(await row.getAttribute('data-group-key')).toBe(key);
    key = await row.getAttribute('data-group-key');
    height = current!.height;
    expect(
      await line.locator('span').evaluate((node) => getComputedStyle(node).animationName),
    ).toBe('none');
  }
  stage = 4;
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 20000 });
  await expect(row).toHaveCount(1);
  await expect(row.getByRole('button')).toBeEnabled();
  stage = 5;
  await expect(page.getByText('Ready for review', { exact: true })).toBeVisible();
  await expect(row).toContainText('4 activities · 2 exchanges');
  await row.getByRole('button').click();
  await expect(page.getByTestId('trajectory-history-entry')).toHaveCount(4);
  expect(
    await page
      .getByTestId('trajectory-work-history')
      .locator('[data-message-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-message-id'))),
  ).toEqual(['activity-0', 'activity-1', 'activity-2', 'activity-3']);
  expect(errors).toEqual([]);
});

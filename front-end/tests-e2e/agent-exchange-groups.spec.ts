/** Browser proof of the quiet GP exchange projection, with real app rendering. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
const OWNER = 'exchange-owner';
test('mobile GP traffic stays collapsed and survives reload without duplicate exchanges', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const user = { id: 'ordinary-exchange-viewer', is_anonymous: false };
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
  const start = new Date(Date.now() - 30000).toISOString();
  const traffic = Array.from({ length: 110 }, (_, i) => {
    const a2a = {
      message_id: `exchange-${i}`,
      kind: i === 1 ? 'question' : 'message',
      from: { id: i % 2 ? 'worker' : OWNER, kind: 'agent', label: i % 2 ? 'Worker' : 'Rose' },
      to: { id: i % 2 ? OWNER : 'worker', kind: 'agent', label: i % 2 ? 'Rose' : 'Worker' },
      text: `Internal coordination ${i}`,
    };
    return [
      {
        message_id: `event-${i}`,
        timestamp: start,
        role: 'USER',
        text: a2a.text,
        metadata: { a2a },
      },
      {
        message_id: `mirror-${i}`,
        timestamp: start,
        role: 'TOOL',
        text: a2a.text,
        metadata: {
          a2a: { ...a2a, direction: 'sent' },
          excludeFromModel: true,
          action_type: 'agent_message',
        },
      },
    ];
  }).flat();
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const agent = {
      agent_id: OWNER,
      goal: 'Coordinate the work',
      model: 'rose-1-flash',
      source: 'WEB',
      reasoning_effort: 'medium',
      progress: 100,
      status: 'COMPLETED',
      created_at: start,
      updated_at: start,
      parent_agent_id: null,
      tools: [],
      context_size: 0,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      message_count: traffic.length,
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
          { message_id: 'human', timestamp: start, role: 'USER', text: 'Coordinate the work' },
          ...traffic,
          {
            message_id: 'final',
            timestamp: start,
            role: 'TOOL',
            text: 'The work is ready for review.',
            metadata: { toolName: 'send_message_to_user', isUserAttentionMessage: true },
          },
        ],
      };
    else if (path === '/api/agents/code-agents') body = { code_agents: [] };
    else if (path === '/api/projects') body = { projects: [] };
    else if (path === '/api/attention-requests') body = { requests: [] };
    else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
    await route.fulfill({ json: body });
  });
  await page.goto(`${FRONTEND_URL}/?agent-id=${OWNER}`, { waitUntil: 'domcontentloaded' });
  const row = page.getByTestId('agent-exchange-group');
  await expect(row).toHaveCount(1, { timeout: 60000 });
  await expect(row).toContainText('110 exchanges');
  await expect(page.getByText('The work is ready for review.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('a2a-row')).toHaveCount(0);
  await row.getByRole('button', { name: /Agents coordinating/ }).click();
  await expect(row.getByTestId('a2a-row')).toHaveCount(20);
  await row.getByRole('button', { name: 'Next exchanges' }).click();
  await expect(row.getByText('Internal coordination 20', { exact: true })).toBeVisible();
  await expect(row.getByText('Internal coordination 0', { exact: true })).toHaveCount(0);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(row).toContainText('110 exchanges');
  await expect(row.getByRole('button', { name: /Agents coordinating/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(page.getByTestId('a2a-row')).toHaveCount(0);
});

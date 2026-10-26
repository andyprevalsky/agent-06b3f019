/**
 * Semantic Test: Cloud-agent lifecycle tool chips.
 *
 * Boots the real front-end in Chromium and serves an agent transcript from
 * mocked API responses. This catches browser-level regressions in the message
 * list, tool deduping, icon rendering, and non-expandable cloud-agent display.
 */
import { expect, test } from '@playwright/test';

import { FRONTEND_URL, attachRecorder, hasUncaughtErrors } from './helpers';

const AGENT_ID = 'semantic-cloud-agent';
const now = new Date('2026-05-07T16:00:00.000Z');

function timestamp(offsetSeconds: number): string {
  return new Date(now.getTime() + offsetSeconds * 1000).toISOString();
}

const user = {
  id: 'semantic-user',
  aud: 'authenticated',
  role: 'authenticated',
  phone: '+19729777432',
  is_anonymous: false,
  app_metadata: { provider: 'phone', providers: ['phone'] },
  user_metadata: {},
  created_at: now.toISOString(),
  updated_at: now.toISOString(),
};

const session = {
  access_token: 'semantic-access-token',
  refresh_token: 'semantic-refresh-token',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  token_type: 'bearer',
  user,
};

const agent = {
  agent_id: AGENT_ID,
  goal: 'Escalate to a cloud agent',
  model: 'anthropic/claude-sonnet-4.5',
  source: 'WEB',
  reasoning_effort: 'medium',
  progress: 0,
  status: 'ACTIVE',
  status_message: 'Starting',
  temporal_workflow_id: null,
  token_count: 0,
  tokens_in: 0,
  tokens_out: 0,
  tool_tokens_in: 0,
  tool_tokens_out: 0,
  tool_cost_cents: 0,
  context_size: 0,
  message_count: 5,
  price_limit_cents: 100,
  tree_cost_cents: 0,
  created_at: timestamp(0),
  updated_at: timestamp(5),
  write_lock_enabled: true,
  verifier: null,
  tools: [],
  response_schema: null,
};

const lifecycleMessages = [
  'Creating Cloud Agent',
  'Preparing Cloud Agent',
  'Starting Reasoning',
  'Cloud Agent Ready',
].map((title, index) => ({
  message_id: `cloud-lifecycle-${index}`,
  timestamp: timestamp(index + 1),
  role: 'TOOL',
  text: `${title} body should stay hidden.`,
  metadata: {
    toolCallId: `tc-cloud-${index}`,
    toolName: 'cloud_agent',
    toolStatus: title === 'Cloud Agent Ready' ? 'FINISHED' : 'IN_PROGRESS',
    title,
  },
}));

test.describe('cloud-agent lifecycle', () => {
  test('renders browser-visible cloud lifecycle chips as non-expandable rows', async ({ page }) => {
    const rec = attachRecorder(page);

    await page.addInitScript(
      ({ sessionValue, userValue }) => {
        window.localStorage.setItem('rose-session', JSON.stringify(sessionValue));
        window.localStorage.setItem('app-user', JSON.stringify(userValue));
      },
      { sessionValue: session, userValue: user },
    );

    let status = 'ACTIVE';
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/')) {
        await route.continue();
        return;
      }

      if (request.method() === 'GET' && url.pathname === '/api/agents') {
        await route.fulfill({ json: { agents: [{ ...agent, status }] } });
        return;
      }

      if (request.method() === 'GET' && url.pathname === `/api/agents/${AGENT_ID}`) {
        await route.fulfill({
          json: {
            agent: { ...agent, status },
            messages: lifecycleMessages,
            pagination: { has_more: false, oldest_timestamp: null },
          },
        });
        return;
      }

      if (request.method() === 'GET' && url.pathname === '/api/invite-codes/check') {
        await route.fulfill({ json: { needsInviteCode: false } });
        return;
      }

      await route.fulfill({ json: {} });
    });

    await page.goto(`${FRONTEND_URL}/?agent-id=${AGENT_ID}`, {
      waitUntil: 'domcontentloaded',
    });

    // Rose Desktop folds a running agent's lifecycle rows into one live trajectory
    // row: it shows the latest lifecycle title with the cloud icon, no progress ring,
    // and cannot be expanded until the work compresses.
    const group = page.getByTestId('trajectory-work-group');
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('data-state', 'running');
    await expect(group.getByTestId('trajectory-activity-line')).toHaveText(
      lifecycleMessages.at(-1)!.metadata.title,
    );
    await expect(group.locator('svg.lucide-cloud')).toHaveCount(1);
    await expect(group.getByTestId('tool-batch-progress-ring')).toHaveCount(0);
    await expect(group.getByRole('button')).toBeDisabled();
    for (const msg of lifecycleMessages) {
      await expect(page.getByText(msg.text, { exact: true })).toHaveCount(0);
    }

    // Once compressed, the history holds every lifecycle chip as a non-expandable row.
    status = 'COMPLETED';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(group).toHaveAttribute('data-state', 'completed');
    await group.getByRole('button').click();
    const history = group.getByTestId('trajectory-work-history');
    for (const msg of lifecycleMessages) {
      await expect(history.getByText(msg.metadata.title, { exact: true })).toBeVisible();
      await expect(page.getByText(msg.text, { exact: true })).toHaveCount(0);
    }

    const rows = history.locator('[data-message-role="TOOL"]');
    await expect(rows).toHaveCount(lifecycleMessages.length);

    for (const row of await rows.all()) {
      await expect(row.locator('svg.lucide-cloud')).toHaveCount(1);
      await expect(row.getByRole('button')).toHaveCount(0);
    }

    expect(hasUncaughtErrors(rec), 'Uncaught errors during cloud-agent lifecycle render').toEqual(
      [],
    );
  });
});

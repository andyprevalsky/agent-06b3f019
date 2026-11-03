/** Real PhoneApp, synthetic broker/frame only; never a live phone or provider. */
import { expect, test } from '@playwright/test';
import { FRONTEND_URL } from './helpers';
for (const width of [1280, 390]) {
  test(`owned phone view and explicit control at ${width}px`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 844 });
    await page.addInitScript(() => {
      const user = { id: 'phone-adapter-viewer', is_anonymous: false };
      localStorage.setItem('app-user', JSON.stringify(user));
      localStorage.setItem(
        'rose-session',
        JSON.stringify({
          user,
          access_token: 'fixture',
          refresh_token: 'fixture',
          token_type: 'bearer',
          expires_at: 9999999999,
        }),
      );
    });
    let controlOwner = 'agent',
      cursor = 0,
      frameReads = 0;
    const commands: Record<string, unknown>[] = [];
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const now = new Date().toISOString();
    const agent = {
      agent_id: 'phone-agent',
      title: 'Use my phone',
      goal: 'Use my phone',
      status: 'ACTIVE',
      source: 'WEB',
      model: 'rose-1-flash',
      reasoning_effort: 'medium',
      created_at: now,
      updated_at: now,
      parent_agent_id: null,
      tools: [],
      context_size: 0,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      message_count: 1,
      price_limit_cents: 100,
      tree_cost_cents: 0,
    };
    const lease = () => ({
      id: 'phone-lease',
      agentId: agent.agent_id,
      browserTaskId: 'phone-task',
      status: 'ACTIVE',
      controlOwner,
      attentionRequestId: null,
      revision: 1,
    });
    await page.route('**/api/**', async (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return route.continue();
      let body: unknown = {};
      if (path === '/api/iphone/interactions/phone-task')
        body = { lease: lease(), cursor, lastOperation: null, pendingOperation: null };
      else if (path === '/api/iphone/leases/phone-lease/frame') {
        frameReads++;
        return route.fulfill({
          contentType: 'image/png',
          body: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
            'base64',
          ),
        });
      } else if (path === '/api/iphone/leases/phone-lease/control') {
        const input = request.postDataJSON();
        commands.push(input);
        controlOwner = input.mode;
        body = { lease: lease() };
      } else if (path === '/api/iphone/leases/phone-lease/operations') {
        const command = request.postDataJSON();
        commands.push(command);
        cursor++;
        body = {
          operation: {
            id: command.operationId,
            operation: command.operation,
            status: 'SUCCEEDED',
            cursor,
            result:
              command.operation === 'screen.bounds'
                ? { x: 20, y: 30, w: 390, h: 844 }
                : { success: true },
          },
        };
      } else if (path === '/api/agents') body = { agents: [agent] };
      else if (path === '/api/agents/phone-agent')
        body = {
          agent,
          messages: [
            {
              message_id: 'phone-event',
              role: 'TOOL',
              text: 'Using phone',
              timestamp: now,
              metadata: { task_id: 'phone-task', action_type: 'phone', toolName: 'phone' },
            },
          ],
          pagination: { has_more: false, oldest_timestamp: null },
        };
      else if (path === '/api/agents/code-agents') body = { code_agents: [] };
      else if (path === '/api/agents/tree') body = { agents: [] };
      else if (path === '/api/projects') body = { projects: [] };
      else if (path === '/api/attention-requests') body = { requests: [] };
      else if (path === '/api/invite-codes/check') body = { needsInviteCode: false };
      else if (request.method() !== 'GET') return route.fulfill({ status: 204 });
      return route.fulfill({ json: body });
    });
    await page.goto(`${FRONTEND_URL}/?agent-id=phone-agent&no-auto-login`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByTestId('rose-app-phone')).toBeVisible();
    await page.getByTestId('rose-app-phone').click();
    const phone = page.getByTestId('rose-phone');
    const screen = phone.getByRole('button', { name: 'Tap cloud iPhone screen' });
    await expect(phone.getByAltText('Cloud iPhone screen')).toBeVisible();
    expect(commands).toEqual([]);
    await expect(screen).toBeDisabled();
    const takeover = phone.getByRole('button', { name: 'Take phone control' });
    const point = await takeover.boundingBox();
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
        { x: point!.x + point!.width / 2, y: point!.y + point!.height / 2 },
      ),
    ).toBe('Take phone control');
    await takeover.click();
    await expect(screen).toBeEnabled();
    await screen.press('Enter');
    await expect
      .poll(() => commands.filter((command) => command.operation === 'input.tap').length)
      .toBe(1);
    expect(commands.find((command) => command.operation === 'input.tap')?.args).toEqual({
      x: 215,
      y: 452,
    });
    await phone.getByRole('button', { name: 'Hand back phone control' }).click();
    await expect(screen).toBeDisabled();
    expect(commands.filter((command) => command.mode === 'user')).toHaveLength(1);
    // The screen disables optimistically; the hand-back request lands after it.
    await expect.poll(() => commands.filter((command) => command.mode === 'agent').length).toBe(1);
    if (width < 768) await phone.getByRole('button', { name: 'Close phone' }).click();
    else await page.getByTestId('rose-app-phone').click();
    await expect(phone).toHaveCount(0);
    const previous = frameReads;
    await page.waitForTimeout(1500); // More than one broker poll interval: closed app must stop.
    expect(frameReads).toBe(previous);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}

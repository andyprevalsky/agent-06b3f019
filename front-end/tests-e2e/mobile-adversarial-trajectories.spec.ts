/** Escalating real-renderer cases. Workload and bounds fixed before execution. */
import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { FRONTEND_URL } from './helpers';
import { mobileResourceMonitor } from './mobile-performance';
import { ADVERSARIAL_AGENTS, installAdversarialTrajectories } from './mobile-adversarial-fixtures';
test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  trace: 'off',
  video: 'off',
  reducedMotion: 'no-preference',
});
async function select(page: Page, id: string) {
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
  await page.getByTestId(`rose-agent-row-${id}`).filter({ visible: true }).click();
}
async function home(page: Page) {
  await page
    .getByTestId('rose-mobile-header')
    .getByRole('button', { name: 'Back', exact: true })
    .click();
  await expect(page.locator('[data-message-id]')).toHaveCount(0);
}
async function latest(page: Page, id: string, count: number) {
  const node = page.locator(`[data-message-id="${id}-${count - 1}"]`);
  await expect(node).toContainText(`for ${id}`);
  await node.scrollIntoViewIfNeeded();
  await expect(node).toBeInViewport();
  const other = ADVERSARIAL_AGENTS.find((candidate) => candidate !== id);
  await expect(page.locator(`[data-message-id^="${other}-"]`)).toHaveCount(0);
}
for (const count of [10_000, 50_000, 100_000]) {
  test(`${count / 1000}k messages per trajectory preserve navigation, oldest content and exit release`, async ({
    page,
  }, info) => {
    test.setTimeout(300_000);
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const fixture = await installAdversarialTrajectories(page, count),
      monitor = await mobileResourceMonitor(page);
    const samples: Record<string, unknown>[] = [],
      started = Date.now();
    const sample = async (label: string) => {
      const value = {
        ...(await monitor.snapshot(label)),
        channels: fixture.realtime(),
        elapsedMs: Date.now() - started,
        renderedMessages: await page.locator('[data-message-id]').count(),
      };
      samples.push(value);
      console.log('MASSIVE_SAMPLE', JSON.stringify(value));
      return value;
    };
    try {
      await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
      // The no-navigation control proves replay initializes its three documents
      // during this window. Measure release against initialized home, preserving
      // every workload step and numeric bound from the cold-baseline receipt.
      await monitor.background();
      const baseline = await sample('home-before');
      await select(page, ADVERSARIAL_AGENTS[0]);
      await latest(page, ADVERSARIAL_AGENTS[0], count);
      await sample('loaded-a');
      const oldest = page.locator(`[data-message-id="${ADVERSARIAL_AGENTS[0]}-0"]`);
      await oldest.scrollIntoViewIfNeeded();
      await expect(oldest).toContainText('Oldest source 0');
      await expect(oldest).toBeInViewport();
      const group = page.getByTestId('trajectory-work-group').first();
      await group.getByRole('button', { name: /Worked/ }).click();
      await expect(group.getByTestId('trajectory-history-entry')).toHaveCount(20);
      await group.getByRole('button', { name: 'Next activities' }).click();
      await expect(group.getByTestId('trajectory-history-entry')).toHaveCount(18);
      await page.screenshot({
        path: info.outputPath('oldest-private.png'),
        animations: 'disabled',
      });
      await home(page);
      await monitor.background();
      const exits = [await sample('home-exit-1')];
      for (let round = 0; round < 2; round++) {
        for (const id of [ADVERSARIAL_AGENTS[1], ADVERSARIAL_AGENTS[0]]) {
          await select(page, id);
          await latest(page, id, count);
          await home(page);
        }
        await monitor.background();
        exits.push(await sample(`home-exit-${round + 2}`));
      }
      for (const exit of exits) {
        expect
          .soft(exit.nodes, `${exit.label}: released DOM`)
          .toBeLessThanOrEqual(baseline.nodes + 500);
        expect
          .soft(exit.listeners, `${exit.label}: released listeners`)
          .toBeLessThanOrEqual(baseline.listeners + 100);
        expect
          .soft(exit.heapBytes, `${exit.label}: released heap`)
          .toBeLessThanOrEqual(baseline.heapBytes * 1.25 + 16 * 1024 * 1024);
        expect.soft(exit.channels.active).toBeLessThanOrEqual(baseline.channels.active);
      }
      expect(errors).toEqual([]);
    } finally {
      fixture.release();
      if (process.env.MOBILE_ADVERSARIAL_HEAP_PATH) {
        await monitor.heapSnapshot(process.env.MOBILE_ADVERSARIAL_HEAP_PATH);
      }
      await writeFile(
        info.outputPath('massive-resources.json'),
        JSON.stringify(
          {
            count,
            responseBytes: fixture.bytes,
            requests: fixture.requests,
            samples,
            errors,
            elapsedMs: Date.now() - started,
            paths: monitor.paths,
            methods: monitor.methods,
          },
          null,
          2,
        ),
      );
      await monitor.dispose();
    }
  });
}

test('cold home initialization control without trajectory navigation', async ({ page }, info) => {
  test.setTimeout(45_000);
  await installAdversarialTrajectories(page, 10_000);
  const monitor = await mobileResourceMonitor(page);
  const samples = [];
  try {
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
    samples.push(await monitor.snapshot('cold-home'));
    for (let i = 0; i < 3; i++) {
      await monitor.background();
      samples.push(await monitor.snapshot(`idle-home-${i}`));
    }
    expect(await page.locator('[data-message-id]').count()).toBe(0);
  } finally {
    await writeFile(info.outputPath('home-initialization.json'), JSON.stringify(samples, null, 2));
    await monitor.dispose();
  }
});

test('10k late transport A to B to A never overwrites the active trajectory', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const fixture = await installAdversarialTrajectories(page, 10_000);
  const monitor = await mobileResourceMonitor(page);
  const samples = [];
  try {
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await select(page, ADVERSARIAL_AGENTS[0]);
    await latest(page, ADVERSARIAL_AGENTS[0], 10_000);
    fixture.hold(ADVERSARIAL_AGENTS[1]);
    await select(page, ADVERSARIAL_AGENTS[1]);
    await expect.poll(() => fixture.held()).toContain(ADVERSARIAL_AGENTS[1]);
    await select(page, ADVERSARIAL_AGENTS[0]);
    await latest(page, ADVERSARIAL_AGENTS[0], 10_000);
    fixture.release();
    await monitor.background();
    await latest(page, ADVERSARIAL_AGENTS[0], 10_000);
    samples.push(await monitor.snapshot('after-late-b'));
    await home(page);
    await monitor.background();
    samples.push(await monitor.snapshot('after-home'));
  } finally {
    fixture.release();
    await writeFile(
      info.outputPath('late-transport.json'),
      JSON.stringify({ samples, requests: fixture.requests }, null, 2),
    );
    await monitor.dispose();
  }
});

test('10k history with 200 alternating assistant/tool wire updates and ordinary inserts', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const fixture = await installAdversarialTrajectories(page, 10_000, { streaming: true });
  const monitor = await mobileResourceMonitor(page),
    samples = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const id = ADVERSARIAL_AGENTS[0],
    started = Date.now();
  try {
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await select(page, id);
    await latest(page, id, 10_000);
    await expect.poll(() => fixture.realtime().active).toBe(2);
    samples.push(await monitor.snapshot('before-burst'));
    for (let index = 0; index < 200; index++) {
      expect(
        fixture.emit(id, 'ASSISTANT_STREAM', {
          agentId: id,
          stream_id: 'burst-assistant',
          delta: `part${index} `,
          sequence: index,
          done: false,
          llm_started_at_ms: started,
          is_gpt: true,
        }),
      ).toBe(1);
      fixture.emit(id, 'TOOL_STREAM', {
        agentId: id,
        stream_id: 'burst-tool-stream',
        tool_call_id: 'burst-tool',
        tool_name: 'read_file',
        title: 'Inspect streamed evidence',
        status: 'IN_PROGRESS',
        char_count: index * 100,
        llm_started_at_ms: started,
        is_gpt: true,
      });
      if (index % 20 === 0)
        fixture.emit(id, 'INSERT', {
          agentId: id,
          id: `burst-user-${index}`,
          timestamp: new Date(started + index).toISOString(),
          role: 'USER',
          text: `Ordinary update ${index} for ${id}`,
        });
      if (index % 10 === 0)
        await page.evaluate(
          () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        );
    }
    fixture.emit(id, 'ASSISTANT_STREAM', {
      agentId: id,
      stream_id: 'burst-assistant',
      delta: '',
      sequence: 200,
      done: true,
      clear_on_done: true,
    });
    fixture.emit(id, 'INSERT', {
      agentId: id,
      id: 'burst-final',
      timestamp: new Date(started + 1000).toISOString(),
      role: 'TOOL',
      text: `Burst final for ${id}`,
      metadata: {
        toolCallId: 'burst-tool',
        toolName: 'send_message_to_user',
        toolStatus: 'FINISHED',
        isUserAttentionMessage: true,
      },
    });
    await expect(page.locator('[data-message-id="burst-final"]')).toContainText(
      `Burst final for ${id}`,
    );
    await expect(page.locator('[data-message-id="streaming:burst-tool"]')).toHaveCount(0);
    await expect(page.locator('[data-message-id="burst-user-180"]')).toContainText(
      'Ordinary update 180',
    );
    await expect(page.locator('[data-message-id^="massive-b-"]')).toHaveCount(0);
    samples.push(await monitor.snapshot('after-burst'));
    await home(page);
    await monitor.background();
    samples.push(await monitor.snapshot('after-home'));
    expect(errors).toEqual([]);
  } finally {
    await writeFile(
      info.outputPath('wire-burst.json'),
      JSON.stringify(
        {
          samples,
          errors,
          elapsedMs: Date.now() - started,
          responseBytes: fixture.bytes,
          channels: fixture.realtime(),
        },
        null,
        2,
      ),
    );
    await monitor.dispose();
  }
});

test('10k history plus 8192-line markdown code body remains fully accessible', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const fixture = await installAdversarialTrajectories(page, 10_000, { huge: true });
  const monitor = await mobileResourceMonitor(page),
    samples = [];
  try {
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await select(page, ADVERSARIAL_AGENTS[0]);
    const last = page.locator('[data-message-id="massive-a-9999"]');
    await expect(last).toContainText('HUGE_BEGIN');
    await expect(last).toContainText('source_8191');
    await last.getByText('HUGE_END', { exact: true }).scrollIntoViewIfNeeded();
    await expect(last.getByText('HUGE_END', { exact: true })).toBeInViewport();
    await expect(last.getByRole('link', { name: 'Source reference' })).toHaveAttribute(
      'href',
      'https://example.com/audit/massive-a/249',
    );
    samples.push(await monitor.snapshot('huge-body-loaded'));
    await home(page);
    await monitor.background();
    samples.push(await monitor.snapshot('huge-body-exit'));
  } finally {
    await writeFile(
      info.outputPath('huge-body.json'),
      JSON.stringify({ samples, responseBytes: fixture.bytes }, null, 2),
    );
    await monitor.dispose();
  }
});

test('10k message details, source links and mobile/desktop copy menus remain usable', async ({
  page,
  context,
}, info) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('https://example.com/audit/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Audit reference</title><p>Source reference preserved</p>',
    }),
  );
  await installAdversarialTrajectories(page, 10_000);
  const monitor = await mobileResourceMonitor(page),
    samples = [];
  const id = ADVERSARIAL_AGENTS[0];
  try {
    await page.goto(`${FRONTEND_URL}/?no-auto-login`, { waitUntil: 'domcontentloaded' });
    await select(page, id);
    await latest(page, id, 10_000);
    const first = page.locator('[data-message-id="massive-a-0"]');
    await first.scrollIntoViewIfNeeded();
    const group = page.getByTestId('trajectory-work-group').first();
    await group.getByRole('button', { name: /Worked/ }).click();
    const entry = group
      .getByTestId('trajectory-history-entry')
      .filter({ has: page.getByText('Audit activity 0/2', { exact: true }) });
    await entry.getByText('Audit activity 0/2', { exact: true }).click();
    await expect(entry).toContainText(
      'Inspect the source, verify ordering and record the full result',
    );
    await latest(page, id, 10_000);
    const popupPromise = context.waitForEvent('page');
    await page
      .locator('[data-message-id="massive-a-9999"]')
      .getByRole('link', { name: 'Source reference' })
      .click();
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toBe('https://example.com/audit/massive-a/249');
    await popup.close();
    await page.getByRole('button', { name: 'Open menu', exact: true }).click();
    const row = () => page.getByTestId(`rose-agent-row-${id}`).filter({ visible: true });
    await row().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`agent-id=${id}`);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 900 });
    await row().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy', exact: true }).hover();
    await page.getByRole('menuitem', { name: 'Copy agent ID', exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(id);
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    await latest(page, id, 10_000);
    samples.push(await monitor.snapshot('after-details-links-responsive-menus'));
    await home(page);
    await monitor.background();
    samples.push(await monitor.snapshot('after-home'));
  } finally {
    await writeFile(info.outputPath('details-menus.json'), JSON.stringify(samples, null, 2));
    await monitor.dispose();
  }
});

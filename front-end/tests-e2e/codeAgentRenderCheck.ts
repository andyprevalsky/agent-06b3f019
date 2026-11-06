/**
 * Render check for a FINISHED code-agent benchmark run (RCA 2026-11-06, Lane B):
 * the root agent and every code agent it spawned render through the existing
 * root transcript and query box, never the old bespoke card / view.
 *
 * INPUT CONTRACT
 *   page          a Playwright page already authenticated on the run's front end
 *                 (local stack dev build auto-logs in; else inject a session)
 *   frontendUrl   the run's front end, e.g. http://localhost:3002
 *   rootAgentId   the root Rose agent of the run (owner of the code agents)
 *   codeAgentIds  optional task ids; default: every code-agent row found in the
 *                 root transcript (data-code-agent-id)
 *
 * CHECKS (each failure names its item)
 *   root  C5   no Claude card header text ("Claude Code Active/Completed …",
 *              "Open app", "Cloud") and no Maximize on a code-agent row
 *         C8   every code-agent row sits inside a "Worked for" history
 *              (trajectory-work-history), nothing rendered below it
 *         C10  no "<branch> → main · pushed" / "Committed <sha> on" rows
 *   view  C2/C4 ≥1 "Worked for" row whose expanded history has ≥1 work row
 *         C9   no work row without history, no two adjacent identical
 *              "Worked for …" rows
 *         C10/C13 no branch/commit rows, no "Session settings unavailable"
 *         C5   no floating "Open app" link in the view (it lives only inside the
 *              devbox usage popover, closed by default)
 *         C11  the query box's model chip names a model; the speed toggle exists
 *         C12  the query box nub carries the context meter
 * C15 (sub-agents in the running-agents drawer) is only visible while a
 * sub-agent runs; it is covered by code-agent-view-transcript.blackbox.tsx.
 *
 * Returns the checked code-agent ids; throws (expect) on the first violation.
 */
import { expect, type Locator, type Page } from '@playwright/test';

const CARD_HEADER = /Claude Code (Active|Completed)|Codex (Active|Completed)|Open app|\bCloud\b/;
const BRANCH_ROWS = /· pushed|Committed [0-9a-f]{7} on/;

async function expandAll(scope: Locator): Promise<void> {
  const groups = scope.getByTestId('trajectory-work-group');
  const count = await groups.count();
  for (let i = 0; i < count; i++) {
    const toggle = groups.nth(i).locator('button[aria-expanded]').first();
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  }
}

async function checkRoot(page: Page, frontendUrl: string, rootAgentId: string): Promise<string[]> {
  await page.goto(`${frontendUrl}/?agent-id=${encodeURIComponent(rootAgentId)}`);
  const main = page.locator('body');
  await expect(main.getByTestId('trajectory-work-group').first()).toBeVisible({ timeout: 60_000 });
  await expandAll(main);
  const rows = main.getByTestId('code-agent-chip');
  await expect(rows.first(), 'C8: a code-agent row inside a Worked for history').toBeVisible();
  const ids: string[] = [];
  for (const row of await rows.all()) {
    const text = (await row.textContent()) ?? '';
    expect(text, 'C5: no Claude card header on the code-agent row').not.toMatch(CARD_HEADER);
    await expect(row.locator('button[aria-label^="Maximize"]'), 'C5: no Maximize').toHaveCount(0);
    expect(
      await row.evaluate((el) => !!el.closest('[data-testid="trajectory-work-history"]')),
      'C8: the code-agent row folds into a Worked for history',
    ).toBe(true);
    expect(
      await row.evaluate((el) => el.nextElementSibling === null),
      'C8: nothing renders below the code-agent row',
    ).toBe(true);
    const id = await row.getAttribute('data-code-agent-id');
    if (id) ids.push(id);
  }
  expect((await main.textContent()) ?? '', 'C10: no branch/commit rows').not.toMatch(BRANCH_ROWS);
  await expect(main.getByTestId('code-agent-session'), 'C10').toHaveCount(0);
  await expect(main.getByTestId('code-agent-summary'), 'C10').toHaveCount(0);
  return ids;
}

async function checkCodeAgent(page: Page, frontendUrl: string, rootAgentId: string, id: string) {
  await page.goto(
    `${frontendUrl}/?agent-id=${encodeURIComponent(rootAgentId)}&code-agent=${encodeURIComponent(id)}`,
  );
  const view = page.getByTestId('code-agent-view');
  await expect(view, `code-agent view ${id}`).toBeVisible({ timeout: 60_000 });
  const groups = view.getByTestId('trajectory-work-group');
  await expect(groups.first(), `C2/C4: ${id} shows its work`).toBeVisible({ timeout: 30_000 });
  await expandAll(view);
  const labels: string[] = [];
  for (const group of await groups.all()) {
    const entries = await group.getByTestId('trajectory-history-entry').count();
    expect(entries, `C4/C9: every work row of ${id} has history rows`).toBeGreaterThan(0);
    labels.push(((await group.locator('button').first().textContent()) ?? '').trim());
  }
  for (let i = 1; i < labels.length; i++) {
    expect(labels[i], `C9: duplicate adjacent work rows in ${id}`).not.toBe(labels[i - 1]);
  }
  await expect(
    view.getByRole('button', { name: 'Open app' }),
    `C5: no floating "Open app" in the view of ${id}`,
  ).toHaveCount(0);
  const box = page.getByTestId('query-input-host');
  await expect(box, 'the code agent query box').toBeVisible();
  for (const scope of [view, box]) {
    const text = (await scope.textContent()) ?? '';
    expect(text, 'C10: no branch/commit rows').not.toMatch(BRANCH_ROWS);
    expect(text, 'C13: no "Session settings unavailable"').not.toContain(
      'Session settings unavailable',
    );
  }
  const model = box.getByTestId('query-model-selector');
  await expect(model, `C11: ${id} model chip`).toBeVisible();
  expect(((await model.textContent()) ?? '').trim(), `C11: ${id} model named`).not.toBe('');
  await expect(box.getByTestId('speed-toggle'), `C11: ${id} speed toggle`).toHaveCount(1);
  await expect(page.getByTestId('query-toolbar-nub'), `C12: ${id} nub`).toHaveCount(1);
  await expect(page.getByTestId('nub-context'), `C12: ${id} context meter`).toHaveCount(1);
}

export async function checkCodeAgentRender(
  page: Page,
  input: { frontendUrl: string; rootAgentId: string; codeAgentIds?: string[] },
): Promise<string[]> {
  const found = await checkRoot(page, input.frontendUrl, input.rootAgentId);
  const ids = input.codeAgentIds?.length ? input.codeAgentIds : found;
  expect(ids.length, 'at least one code agent to check').toBeGreaterThan(0);
  for (const id of ids) await checkCodeAgent(page, input.frontendUrl, input.rootAgentId, id);
  return ids;
}

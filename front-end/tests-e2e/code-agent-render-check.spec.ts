/**
 * Benchmark entry for codeAgentRenderCheck.ts against a finished run's stack.
 *
 *   cd front-end && CODE_AGENT_CHECK_ROOT_ID=<root agent id> \
 *     [CODE_AGENT_CHECK_IDS=<task id>,<task id>] FRONTEND_URL=http://localhost:<fe port> \
 *     npx playwright test tests-e2e/code-agent-render-check.spec.ts
 *
 * Skips (never fails) when CODE_AGENT_CHECK_ROOT_ID is unset, so the semantic
 * lane's full Playwright run is unaffected. Authenticates like the other local
 * specs (dev auto-login), or with SEMANTIC_SESSION when injected.
 */
import { test } from '@playwright/test';

import { checkCodeAgentRender } from './codeAgentRenderCheck';
import {
  FRONTEND_URL,
  HAS_INJECTED_SESSION,
  attachRecorder,
  expectDevAuthenticated,
  injectSemanticSession,
} from './helpers';

const ROOT = process.env.CODE_AGENT_CHECK_ROOT_ID?.trim() ?? '';
const IDS = (process.env.CODE_AGENT_CHECK_IDS ?? '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

test('code-agent run renders through the root transcript and query box', async ({ page }) => {
  test.skip(ROOT === '', 'CODE_AGENT_CHECK_ROOT_ID not set (benchmark-only check)');
  const rec = attachRecorder(page);
  if (HAS_INJECTED_SESSION) await injectSemanticSession(page);
  await page.goto(FRONTEND_URL);
  await expectDevAuthenticated(page, rec);
  await checkCodeAgentRender(page, {
    frontendUrl: FRONTEND_URL,
    rootAgentId: ROOT,
    codeAgentIds: IDS,
  });
});

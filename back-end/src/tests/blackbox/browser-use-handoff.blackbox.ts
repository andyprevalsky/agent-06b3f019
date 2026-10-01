#!/usr/bin/env tsx

import { runLiveBrowserUseHandoff } from './browser-provider.browser-use-handoff.live';

if (process.env.RUN_BROWSER_USE_LIVE === '1') {
  runLiveBrowserUseHandoff().catch((error) => {
    console.error(`FAIL live Browser Use handoff: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
} else {
  console.log('SKIP live Browser Use handoff (set RUN_BROWSER_USE_LIVE=1)');
}

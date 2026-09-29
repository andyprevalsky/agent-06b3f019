#!/usr/bin/env node

/** Verify that an empty browser profile actually renders a shared agent. */
const fs = require('node:fs');
const { chromium } = require('playwright');

async function main() {
  const { url, agentId, snippets } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const chrome = process.env.CHROME_PATH ||
    (fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined);
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ['--no-sandbox'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const apiStatuses = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith(`/api/benchmarks/shared-agent/${agentId}`)) {
        apiStatuses.push(response.status());
      }
    });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.getByText('Read-only benchmark recording').waitFor({ timeout: 30000 });
    await page.waitForFunction(
      (texts) => texts.some((text) => document.body.innerText.includes(text)),
      snippets,
      { timeout: 30000 },
    );
    if (!apiStatuses.includes(200)) throw new Error('shared agent API did not return HTTP 200');
    if (await page.getByText("You're On The Waitlist!").isVisible()) {
      throw new Error('waitlist gate obscures the shared agent');
    }
    process.stdout.write('fresh-browser shared agent visible\n');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

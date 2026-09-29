#!/usr/bin/env node

/** Verify that an empty browser profile actually renders a shared agent. */
const fs = require("node:fs");
const { chromium } = require("playwright");

async function main() {
  const { url, agentId, snippets } = JSON.parse(fs.readFileSync(0, "utf8"));
  const chrome =
    process.env.CHROME_PATH ||
    (fs.existsSync("/usr/bin/google-chrome")
      ? "/usr/bin/google-chrome"
      : undefined);
  const browser = await chromium.launch({
    headless: true,
    ...(chrome ? { executablePath: chrome } : {}),
    args: ["--no-sandbox"],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const apiStatuses = [];
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname.endsWith(
          `/api/benchmarks/shared-agent/${agentId}`,
        )
      ) {
        apiStatuses.push(response.status());
      }
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .getByText("Read-only benchmark recording")
      .waitFor({ timeout: 30000 });
    await assertTranscript(page, snippets);
    if (new URL(page.url()).searchParams.has("benchmark-share"))
      throw new Error("bearer token remained in the browser URL");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page
      .getByText("Read-only benchmark recording")
      .waitFor({ timeout: 30000 });
    await assertTranscript(page, snippets);
    if (!apiStatuses.includes(200))
      throw new Error("shared agent API did not return HTTP 200");
    if (await page.getByText("You're On The Waitlist!").isVisible()) {
      throw new Error("waitlist gate obscures the shared agent");
    }
    process.stdout.write("fresh-browser shared agent visible\n");
  } finally {
    await browser.close();
  }
}

async function assertTranscript(page, snippets) {
  if (
    snippets.assistant.length > 0 &&
    !(await page.evaluate(
      (texts) => texts.some((text) => document.body.innerText.includes(text)),
      snippets.assistant,
    ))
  ) {
    // Archived assistant progress may be inside a collapsed Thought section.
    await page.getByText("Thought", { exact: true }).first().click();
  }
  await page.waitForFunction(
    ({ user, assistant }) => {
      const body = document.body.innerText;
      return (
        user.some((text) => body.includes(text)) &&
        (assistant.length === 0 ||
          assistant.some((text) => body.includes(text)))
      );
    },
    snippets,
    { timeout: 30000 },
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

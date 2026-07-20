/**
 * Seed the LOCAL dev DB with one ACTIVE agent that is mid browser session, so
 * the real browser view (BrowserStatusBar / fullscreen) renders against real
 * data — not mock props.
 *
 * The FE derives an ACTIVE browser panel (front-end derivations.ts
 * `computeActiveBrowserPanels`) from messages where:
 *   - metadata.task_id is set AND metadata.toolName === 'spawn_browser_agent'
 *   - an init message has action_type ∈ {browser, system, session_started}
 *     and a string metadata.browser_url
 *   - NO terminal message (toolStatus FINISHED/ERROR, or action_type
 *     task_complete/session_paused) at tool-call scope
 * Step progress comes from metadata.steps_taken / metadata.total_steps.
 *
 * Idempotent: re-running replaces the same fixed agent + its messages.
 *
 * Usage (LOCAL db):
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:<port>/victoria \
 *   DIRECT_URL=postgresql://postgres:postgres@localhost:<port>/victoria \
 *   npx tsx scripts/seed-browser-agent.ts
 *
 * To attach a real provider session while preserving its tracked task ID:
 *   BROWSER_TASK_ID=<uuid> BROWSER_URL=<live-view-url> ... npx tsx scripts/seed-browser-agent.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEV_USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const DEV_PHONE = '+19729777432';
const AGENT_ID = 'b0b0b0b0-0000-4000-8000-000000000001';
const TASK_ID = process.env.BROWSER_TASK_ID?.trim() || 'browser-task-seed-1';
const GOAL = 'Buy me a black Carhartt beanie under $25 and ship it to my apartment';

// A live-view stand-in the iframe can actually render (a real Steel live-view
// URL only exists for a live session). Reads as a shopping page in the panel.
const MOCK_LIVE_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
 body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#111}
 .bar{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eee;font-size:13px;color:#555}
 .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px}
 .card{border:1px solid #eee;border-radius:10px;overflow:hidden}.card.sel{outline:2px solid #f59e0b}
 .ph{height:120px;background:linear-gradient(135deg,#f2f2f4,#e7e7ea)}
 .meta{padding:8px 10px}.t{font-size:12px;line-height:1.3;color:#222}.p{font-weight:700;margin-top:4px}
</style></head><body>
 <div class="bar">🔍 carhartt knit beanie black &nbsp;·&nbsp; amazon.com</div>
 <div class="grid">
  <div class="card sel"><div class="ph"></div><div class="meta"><div class="t">Carhartt Men's Knit Cuffed Beanie, Black</div><div class="p">$19.99 · ★ 4.8 (167k)</div></div></div>
  <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Acrylic Watch Hat</div><div class="p">$16.99</div></div></div>
  <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Rib Knit Beanie</div><div class="p">$21.99</div></div></div>
  <div class="card"><div class="ph"></div><div class="meta"><div class="t">Carhartt Fleece 2-in-1 Hat</div><div class="p">$24.99</div></div></div>
 </div>
</body></html>`)}`;
const LIVE_PAGE = process.env.BROWSER_URL?.trim() || MOCK_LIVE_PAGE;

type Meta = Record<string, unknown>;

function browserMeta(extra: Meta): Meta {
  return {
    toolName: 'spawn_browser_agent',
    task_id: TASK_ID,
    subAgentId: TASK_ID,
    ...extra,
  };
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const host = url.replace(/postgres(ql)?:\/\/[^@]*@/, '').split('/')[0];
  if (!/localhost|127\.0\.0\.1/.test(host)) {
    throw new Error(
      `Refusing to seed: DATABASE_URL host is "${host}", not local. Set DATABASE_URL + DIRECT_URL to the local dev DB.`
    );
  }

  // 1. Ensure the dev user exists so FE auth resolves the seeded agent locally.
  // Agents are owned by the Supabase uid (Agent.userId === User.userId), which
  // is DEV_USER_ID. The User row's primary `id` is a separate uuid, so match on
  // the unique `userId` and only create if truly absent.
  const existing = await prisma.user.findUnique({ where: { userId: DEV_USER_ID } });
  if (!existing) {
    await prisma.user.create({
      data: { userId: DEV_USER_ID, phone: DEV_PHONE, name: 'Andy Prevalsky' },
    });
  }

  // 2. Replace the fixed agent (cascade deletes its messages).
  await prisma.agent.deleteMany({ where: { id: AGENT_ID } });
  await prisma.agent.create({
    data: {
      id: AGENT_ID,
      userId: DEV_USER_ID,
      goal: GOAL,
      status: 'ACTIVE',
      source: 'WEB',
      progress: 0.42,
      temporalWorkflowId: 'wf-seed-browser-1',
      messageCount: 0,
      priceLimitCents: 100,
      treeCostCents: 18,
    },
  });

  // 3. Messages: user goal + a realistic ACTIVE browser trajectory. Every
  // browser-subagent row carries subAgentId so the Progress tab can render it.
  // There is intentionally no task_complete row, so the panel remains ACTIVE.
  const base = Date.now() - 150_000;
  const rows: { text: string; role: 'USER' | 'TOOL'; metadata: Meta; offset: number }[] = [
    { text: GOAL, role: 'USER', metadata: {}, offset: 0 },
    {
      text: 'I’ll search Amazon, compare the strongest options under $25, and verify the final total before checkout.',
      role: 'TOOL',
      metadata: {
        task_id: TASK_ID,
        subAgentId: TASK_ID,
        toolCallId: 'browser-thought-1',
        toolName: 'thought',
        title: 'Thinking',
        toolStatus: 'FINISHED',
      },
      offset: 2_000,
    },
    {
      text: 'Started browser session',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-session-start',
        action_type: 'session_started',
        browser_url: LIVE_PAGE,
        title: 'Started browser session',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 1,
        total_steps: 20,
      }),
      offset: 5_000,
    },
    {
      text: 'Navigating to amazon.com',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-navigate-amazon',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Navigate to amazon.com',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 3,
        total_steps: 20,
      }),
      offset: 11_000,
    },
    {
      text: 'Loaded the Amazon results page and scanned the available filters',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-scan-results',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Scanning search results',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 4,
        total_steps: 20,
      }),
      offset: 18_000,
    },
    {
      text: 'Searching "carhartt knit beanie black"',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-search-beanie',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Search "carhartt knit beanie black"',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 6,
        total_steps: 20,
      }),
      offset: 26_000,
    },
    {
      text: 'Compared color, price, Prime delivery, rating, and review count',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-compare-products',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Comparing 6 matching products',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 7,
        total_steps: 20,
      }),
      offset: 34_000,
    },
    {
      text: 'Selecting the black cuffed beanie',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-select-product',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Open product · Carhartt Cuffed Beanie',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 8,
        total_steps: 20,
      }),
      offset: 42_000,
    },
    {
      text: 'Verified the selected item is black, in stock, and priced at $19.99',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-verify-product',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Verifying product details',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 9,
        total_steps: 20,
      }),
      offset: 49_000,
    },
    {
      text: 'Adding item to cart',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-add-to-cart',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Add to cart · $19.99',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 10,
        total_steps: 20,
      }),
      offset: 55_000,
    },
    {
      text: 'Opening the cart to confirm shipping and taxes before requesting approval',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-open-cart',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Reviewing cart total',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 11,
        total_steps: 20,
      }),
      offset: 59_000,
    },
    {
      text: 'Checking whether the item can arrive before the weekend',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-delivery-date',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Checking promised delivery date',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 12,
        total_steps: 30,
      }),
      offset: 63_000,
    },
    {
      text: 'Confirming the item is sold by Amazon and fulfilled by Amazon',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-seller',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Confirming seller and fulfillment',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 13,
        total_steps: 30,
      }),
      offset: 67_000,
    },
    {
      text: 'Reviewing the return window and free-return eligibility',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-returns',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Checking return policy',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 14,
        total_steps: 30,
      }),
      offset: 71_000,
    },
    {
      text: 'Opening the product rating breakdown',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-open-ratings',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Opening rating breakdown',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 15,
        total_steps: 30,
      }),
      offset: 75_000,
    },
    {
      text: 'Reading recent reviews that mention warmth and fit',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-read-reviews',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Reading recent customer reviews',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 16,
        total_steps: 30,
      }),
      offset: 79_000,
    },
    {
      text: 'Checking critical reviews for recurring quality issues',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-read-critical-reviews',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Checking critical reviews',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 17,
        total_steps: 30,
      }),
      offset: 83_000,
    },
    {
      text: 'Returning to the product detail page',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-return-product',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Returning to product details',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 18,
        total_steps: 30,
      }),
      offset: 87_000,
    },
    {
      text: 'Confirming the one-size option matches the requested fit',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-size',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Verifying size and fit',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 19,
        total_steps: 30,
      }),
      offset: 91_000,
    },
    {
      text: 'Reconfirming that the selected color is Black',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-recheck-color',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Reconfirming selected color · Black',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 20,
        total_steps: 30,
      }),
      offset: 95_000,
    },
    {
      text: 'Checking whether an additional coupon can be applied',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-coupon',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Checking available coupons',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 21,
        total_steps: 30,
      }),
      offset: 99_000,
    },
    {
      text: 'Opening the cart again with the verified selection',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-reopen-cart',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Reopening cart',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 22,
        total_steps: 30,
      }),
      offset: 103_000,
    },
    {
      text: 'Estimating sales tax for the saved shipping address',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-estimate-tax',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Estimating tax',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 23,
        total_steps: 30,
      }),
      offset: 107_000,
    },
    {
      text: 'Verifying the saved apartment shipping address',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-address',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Verifying shipping address',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 24,
        total_steps: 30,
      }),
      offset: 111_000,
    },
    {
      text: 'Confirming the order remains below the $25 limit after tax',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-check-final-total',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Checking final order total',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 25,
        total_steps: 30,
      }),
      offset: 115_000,
    },
    {
      text: 'Pausing before checkout so the final purchase can be approved',
      role: 'TOOL',
      metadata: browserMeta({
        toolCallId: 'browser-await-checkout',
        action_type: 'browser',
        browser_url: LIVE_PAGE,
        title: 'Waiting for checkout approval',
        toolStatus: 'IN_PROGRESS',
        steps_taken: 26,
        total_steps: 30,
      }),
      offset: 119_000,
    },
  ];

  await prisma.message.createMany({
    data: rows.map((r) => ({
      agentId: AGENT_ID,
      text: r.text,
      role: r.role,
      timestamp: new Date(base + r.offset),
      createdAt: new Date(base + r.offset),
      metadata: r.metadata as object,
    })),
  });
  await prisma.agent.update({ where: { id: AGENT_ID }, data: { messageCount: rows.length } });

  console.log(`✅ Seeded ACTIVE browser-view agent`);
  console.log(`   agent_id = ${AGENT_ID}`);
  console.log(`   user_id  = ${DEV_USER_ID}`);
  console.log(`   messages = ${rows.length} (task_id=${TASK_ID}, no terminal → panel is ACTIVE)`);
  console.log(`   open:    <frontend>/?agent-id=${AGENT_ID}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());

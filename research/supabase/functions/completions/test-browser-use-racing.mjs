/**
 * Test rose-1-browser-use: per-model validation + completion-based trio racing
 *
 * Tests each model individually via model_seed to confirm it returns a valid action,
 * then tests the racing harness.
 *
 * Pool:
 *   [0] browser-use  (bu-1-0)
 *   [1] yutori/n1    (vision-only, needs screenshot)
 *   [2] openai/gpt-5.2  (DOM-only, via OpenRouter)
 *   [3] anthropic/claude-opus-4.7  (DOM-only, direct Anthropic)
 *
 * Run: node test-browser-use-racing.mjs
 * Run single: node test-browser-use-racing.mjs --only=gpt-5.2
 */

import process from 'node:process';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321/functions/v1/completions';

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) {
    console.log(`  FAIL: ${message}`);
    failed++;
    failures.push(message);
  } else {
    console.log(`  PASS: ${message}`);
    passed++;
  }
}

// Production available_actions (from agents/browser_tools/schemas.py BROWSER_TOOL_MODELS)
const AVAILABLE_ACTIONS = [
  'screenshot',
  'extract',
  'click',
  'input_text',
  'press_key',
  'click_coordinates',
  'dropdown_options',
  'select_dropdown',
  'evaluate',
  'goto',
  'navback',
  'scroll',
  'wait',
  'switch_tab',
  'close_tab',
  'open_new_tab',
  'upload_file',
  'attempt_completion',
];

// Realistic DOM tree matching production format (dom_service.py output)
const REALISTIC_DOM_TREE = `[Start of page]
[1] nav "Main Navigation"
  [2] a "Home" href="/"
  [3] a "Products" href="/products"
  [4] a "Pricing" href="/pricing"
  [5] button "Sign In"
  [6] button "Get Started" class="primary"
[7] main "Page Content"
  [8] section "Hero"
    [9] h1 "Build faster with AI agents"
    [10] p "Automate your browser workflows with intelligent agents that learn and adapt."
    [11] input[type=email] placeholder="Enter your email"
    [12] button "Start Free Trial"
  [13] section "Features"
    [14] h2 "Features"
    [15] div "Feature Card"
      [16] h3 "Browser Automation"
      [17] p "Control any website with natural language instructions"
    [18] div "Feature Card"
      [19] h3 "Visual Understanding"
      [20] p "AI sees and understands page content like a human"
    [21] div "Feature Card"
      [22] h3 "Multi-step Tasks"
      [23] p "Chain complex workflows across multiple pages"
  [24] section "Pricing"
    [25] h2 "Simple Pricing"
    [26] div "Plan"
      [27] h3 "Free"
      [28] p "$0/month"
      [29] button "Get Started"
    [30] div "Plan"
      [31] h3 "Pro"
      [32] p "$49/month"
      [33] button "Subscribe"
[34] footer "Footer"
  [35] a "Terms" href="/terms"
  [36] a "Privacy" href="/privacy"
  [37] a "Contact" href="/contact"
[End of page]`;

// Minimal 1x1 white PNG (valid base64 screenshot for yutori)
const TINY_SCREENSHOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function makeRequest(overrides = {}) {
  return {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Click the "Sign In" button',
    browser_state: {
      url: 'https://example.com',
      title: 'Example - Build faster with AI agents',
      dom_tree: REALISTIC_DOM_TREE,
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0, pages_above: 0, pages_below: 0, total_pages: 1.0 },
      tabs: [{
        id: 0,
        url: 'https://example.com',
        title: 'Example - Build faster with AI agents',
        active: true,
      }],
      page_stats: { links: 7, interactive: 8, total: 37 },
    },
    action_history: [],
    available_actions: AVAILABLE_ACTIONS,
    ...overrides,
  };
}

async function callAPI(request, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startTime = Date.now();
  try {
    const response = await fetch(SUPABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });
    const elapsed = Date.now() - startTime;
    const data = await response.json();
    return { data, elapsed, status: response.status, error: null };
  } catch (e) {
    const elapsed = Date.now() - startTime;
    return {
      data: null,
      elapsed,
      status: 0,
      error: e.name === 'AbortError' ? `Timeout after ${timeoutMs}ms` : e.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Validate a browser-use response has the required shape
function validateAction(data, label) {
  assert(data.action, `${label}: action field present`);
  assert(data.action?.action, `${label}: action.action has type: ${data.action?.action}`);

  const actionType = data.action?.action;
  if (actionType) {
    assert(
      AVAILABLE_ACTIONS.includes(actionType),
      `${label}: action type "${actionType}" is valid (in AVAILABLE_ACTIONS)`,
    );
  }

  // click must have index
  if (actionType === 'click') {
    assert(data.action?.index !== undefined, `${label}: click has index: ${data.action?.index}`);
  }

  assert(data.actual_model, `${label}: actual_model present: ${data.actual_model}`);
  assert(data.ttft_ms > 0, `${label}: ttft_ms > 0: ${data.ttft_ms}ms`);
  assert(data.usage, `${label}: usage present`);
  if (data.usage) {
    assert(
      data.usage.prompt_tokens > 0,
      `${label}: prompt_tokens > 0: ${data.usage.prompt_tokens}`,
    );
    assert(
      data.usage.completion_tokens > 0,
      `${label}: completion_tokens > 0: ${data.usage.completion_tokens}`,
    );
  }
}

// ============================================================
// TEST: Individual model via model_seed
// ============================================================
async function testModel(seed, expectedModel, label, extraOverrides = {}, timeoutMs = 60000) {
  console.log('\n' + '='.repeat(60));
  console.log(`TEST: ${label} (model_seed=${seed})`);
  console.log('='.repeat(60));

  const { data, elapsed, status, error } = await callAPI(
    makeRequest({ model_seed: seed, ...extraOverrides }),
    timeoutMs,
  );

  if (error) {
    console.log(`\n  ERROR: ${error} (${elapsed}ms)`);
    assert(false, `${label}: request completed without error`);
    return;
  }

  console.log(`\nStatus: ${status}, Time: ${elapsed}ms`);
  console.log(`actual_model: ${data.actual_model}`);
  console.log(`action: ${JSON.stringify(data.action)}`);

  if (status !== 200) {
    console.log(`Error response: ${JSON.stringify(data, null, 2)}`);
    assert(false, `${label}: HTTP 200 (got ${status})`);
    return;
  }

  assert(status === 200, `${label}: HTTP 200`);
  assert(
    data.actual_model?.includes(expectedModel) || data.actual_model === expectedModel,
    `${label}: actual_model contains "${expectedModel}" (got "${data.actual_model}")`,
  );
  assert(!data.racing, `${label}: no racing metadata (seeded)`);

  validateAction(data, label);
}

// ============================================================
// TEST: Racing (no model_seed)
// ============================================================
async function testRacing() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: Completion-based trio racing');
  console.log('='.repeat(60));

  const { data, elapsed, status, error } = await callAPI(makeRequest());

  if (error) {
    console.log(`\n  ERROR: ${error} (${elapsed}ms)`);
    assert(false, 'Racing: request completed without error');
    return;
  }

  console.log(`\nStatus: ${status}, Time: ${elapsed}ms`);
  console.log(`Winner: ${data.actual_model} (${data.ttft_ms}ms)`);

  if (status !== 200) {
    console.log(`Error response: ${JSON.stringify(data, null, 2)}`);
    assert(false, `Racing: HTTP 200 (got ${status})`);
    return;
  }

  assert(status === 200, 'Racing: HTTP 200');
  validateAction(data, 'Racing');

  assert(
    data.pool_name === 'rose-1-browser-use',
    `Racing: pool_name correct (got ${data.pool_name})`,
  );
  assert(data.pool_size === 4, `Racing: pool_size is 4 (got ${data.pool_size})`);
  assert(data.racing, 'Racing: racing metadata present');
  assert(
    data.racing?.models_raced >= 2,
    `Racing: models_raced >= 2 (got ${data.racing?.models_raced})`,
  );
  assert(
    data.racing?.racing_type === 'completion_trio',
    `Racing: racing_type correct (got ${data.racing?.racing_type})`,
  );
  assert(
    data.racing?.trio?.length >= 2,
    `Racing: trio array present (${data.racing?.trio?.length} models)`,
  );

  if (data.racing?.trio) {
    for (const entry of data.racing.trio) {
      assert(entry.model, `Racing: trio entry has model: ${entry.model}`);
      assert(entry.delay_ms !== undefined, `Racing: trio entry has delay_ms: ${entry.delay_ms}`);
    }
  }
}

// ============================================================
// TEST: No screenshot filters yutori
// ============================================================
async function testNoScreenshotFiltering() {
  console.log('\n' + '='.repeat(60));
  console.log('TEST: No screenshot filters yutori out of pool');
  console.log('='.repeat(60));

  // makeRequest() has no screenshot by default
  const { data, elapsed, status, error } = await callAPI(makeRequest());

  if (error || status !== 200) {
    console.log(`Status: ${status}, Error: ${error}`);
    assert(false, 'No-screenshot: request succeeded');
    return;
  }

  console.log(`\nStatus: ${status}, Time: ${elapsed}ms`);

  if (data.racing?.trio) {
    const trioModels = data.racing.trio.map((t) => t.model);
    console.log(`Trio: ${trioModels.join(', ')}`);
    assert(
      !trioModels.includes('yutori/n1'),
      `No-screenshot: yutori NOT in trio [${trioModels.join(', ')}]`,
    );
  } else {
    console.log('No trio metadata - checking winner is not yutori');
    assert(data.actual_model !== 'yutori/n1', 'No-screenshot: winner is not yutori');
  }
}

// ============================================================
// RUN
// ============================================================
async function runAllTests() {
  const onlyFilter = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];

  console.log('rose-1-browser-use Model Validation + Racing Tests');
  console.log(`Endpoint: ${SUPABASE_URL}`);
  console.log(
    `Pool: [0] browser-use, [1] yutori/n1, [2] openai/gpt-5.2, [3] anthropic/claude-opus-4.7`,
  );
  if (onlyFilter) console.log(`Filter: --only=${onlyFilter}`);
  console.log('');

  const tests = [
    { name: 'browser-use', fn: () => testModel(0, 'browser-use', 'browser-use (seed=0)') },
    {
      name: 'yutori',
      fn: () =>
        testModel(1, 'yutori', 'yutori/n1 (seed=1)', {
          browser_state: {
            url: 'https://example.com',
            title: 'Example - Build faster with AI agents',
            dom_tree: REALISTIC_DOM_TREE,
            screenshot: TINY_SCREENSHOT,
            viewport: { width: 1280, height: 720 },
            scroll_position: { x: 0, y: 0, pages_above: 0, pages_below: 0, total_pages: 1.0 },
            tabs: [{ id: 0, url: 'https://example.com', title: 'Example', active: true }],
            page_stats: { links: 7, interactive: 8, total: 37 },
          },
        }),
    },
    { name: 'gpt-5.2', fn: () => testModel(2, 'gpt-5.2', 'openai/gpt-5.2 (seed=2)', {}, 90000) },
    { name: 'opus-4.7', fn: () => testModel(3, 'opus-4.7', 'anthropic/claude-opus-4.7 (seed=3)') },
    { name: 'racing', fn: () => testRacing() },
    { name: 'no-screenshot', fn: () => testNoScreenshotFiltering() },
  ];

  for (const test of tests) {
    if (onlyFilter && !test.name.includes(onlyFilter)) {
      console.log(`\nSKIPPED: ${test.name} (--only=${onlyFilter})`);
      continue;
    }
    await test.fn();
    // Brief pause between tests
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  console.log('\n' + (failed === 0 ? 'ALL TESTS PASSED' : `${failed} TESTS FAILED`));
  console.log('='.repeat(60));

  process.exit(failed > 0 ? 1 : 0);
}

runAllTests().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});

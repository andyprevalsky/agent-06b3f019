/**
 * Test rose-1-browser-use usage output for both providers
 *
 * Tests model_seed=0 (browser-use) and model_seed=1 (yutori)
 * Verifies usage is returned in format: { prompt_tokens, completion_tokens, total_tokens }
 *
 * Run: node test-browser-use-usage.mjs
 */

import { Buffer } from 'node:buffer';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const SUPABASE_URL = 'https://kzlurqihzaolhzsbkctf.supabase.co/functions/v1/completions';

// Fetch a sample screenshot and convert to base64
async function getScreenshotBase64() {
  console.log('📸 Fetching sample screenshot...');
  const imageUrl =
    'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png';

  const response = await fetch(imageUrl);
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  console.log(`📸 Screenshot fetched: ${base64.length} chars base64\n`);
  return base64;
}

async function testProviderUsage(modelSeed, providerName, screenshot) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing model_seed=${modelSeed} (${providerName})`);
  console.log('='.repeat(60));

  const request = {
    model: 'rose-labs/rose-1-browser-use',
    task: 'Click the "Sign In" button',
    browser_state: {
      url: 'https://example.com',
      dom_tree: `[1] header "Navigation"
  [2] button "Home"
  [3] button "About"
  [4] button "Sign In"
  [5] button "Sign Up"
[6] main "Content"
  [7] h1 "Welcome to Example.com"`,
      screenshot: screenshot,
      viewport: { width: 1280, height: 720 },
      scroll_position: { x: 0, y: 0 },
    },
    action_history: [],
    available_actions: ['click', 'type', 'scroll', 'goto', 'done'],
    model_seed: modelSeed,
  };

  console.log('\n📤 Request (screenshot truncated):');
  const displayRequest = { ...request };
  displayRequest.browser_state = { ...request.browser_state };
  displayRequest.browser_state.screenshot = `<${screenshot.length} chars base64>`;
  console.log(JSON.stringify(displayRequest, null, 2));

  const startTime = Date.now();

  try {
    const response = await fetch(SUPABASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ROSE_API_KEY,
      },
      body: JSON.stringify(request),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`\n❌ Error: ${response.status}`);
      console.log(errorText);
      return { success: false, provider: providerName, error: errorText };
    }

    const data = await response.json();

    console.log('\n📥 Response:');
    console.log(JSON.stringify(data, null, 2));
    console.log(`\n⏱️ Total time: ${elapsed}ms`);
    console.log(`⏱️ TTFT (from provider): ${data.ttft_ms}ms`);

    // Check for usage
    const hasUsage = data.usage &&
      typeof data.usage.prompt_tokens === 'number' &&
      typeof data.usage.completion_tokens === 'number' &&
      typeof data.usage.total_tokens === 'number';

    if (hasUsage) {
      console.log('\n✅ USAGE FOUND:');
      console.log(`   prompt_tokens: ${data.usage.prompt_tokens}`);
      console.log(`   completion_tokens: ${data.usage.completion_tokens}`);
      console.log(`   total_tokens: ${data.usage.total_tokens}`);
    } else {
      console.log('\n⚠️ NO USAGE DATA or incomplete usage:');
      console.log(`   usage: ${JSON.stringify(data.usage)}`);
    }

    return {
      success: true,
      provider: providerName,
      actual_model: data.actual_model,
      hasUsage,
      usage: data.usage,
      ttft_ms: data.ttft_ms,
      action: data.action?.action,
    };
  } catch (error) {
    console.error(`\n❌ Request failed: ${error.message}`);
    return { success: false, provider: providerName, error: error.message };
  }
}

async function runAllTests() {
  console.log('🧪 Testing rose-1-browser-use Usage Output\n');
  console.log('Pool: rose-1-browser-use');
  console.log('  [0] browser-use (bu-1-0)');
  console.log('  [1] yutori/n1');

  // Get screenshot once
  const screenshot = await getScreenshotBase64();

  const results = [];

  // Test browser-use (model_seed=0)
  results.push(await testProviderUsage(0, 'browser-use (bu-1-0)', screenshot));

  // Brief pause
  await new Promise((r) => setTimeout(r, 1000));

  // Test yutori (model_seed=1)
  results.push(await testProviderUsage(1, 'yutori/n1', screenshot));

  // Summary
  console.log('\n\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const r of results) {
    const status = r.success ? (r.hasUsage ? '✅' : '⚠️') : '❌';
    console.log(`\n${status} ${r.provider}`);
    if (r.success) {
      console.log(`   actual_model: ${r.actual_model}`);
      console.log(`   action: ${r.action}`);
      console.log(`   ttft_ms: ${r.ttft_ms}`);
      if (r.hasUsage) {
        console.log(
          `   usage: { prompt_tokens: ${r.usage.prompt_tokens}, completion_tokens: ${r.usage.completion_tokens}, total_tokens: ${r.usage.total_tokens} }`,
        );
      } else {
        console.log(`   usage: MISSING or incomplete`);
      }
    } else {
      console.log(`   error: ${r.error}`);
    }
  }

  const allHaveUsage = results.every((r) => r.success && r.hasUsage);
  console.log('\n' + '='.repeat(60));
  console.log(
    allHaveUsage
      ? '✅ All providers return usage correctly!'
      : '⚠️ Some providers missing usage data',
  );
  console.log('='.repeat(60));
}

runAllTests().catch(console.error);

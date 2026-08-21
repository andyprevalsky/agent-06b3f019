/**
 * Test script to validate fingerprint sync between local browser and Steel session.
 *
 * Usage: npx tsx back-end/scripts/test-fingerprint-sync.ts [userId]
 *
 * This script:
 * 1. Creates a Steel session with fingerprint injection
 * 2. Navigates to fingerprint testing sites
 * 3. Extracts actual HTTP headers and JS values
 * 4. Compares with expected values from stored fingerprint
 * 5. Reports all mismatches
 */

import { chromium } from 'playwright';
import { prisma } from '../src/lib/prisma';
import { createSessionWithContext, getOrCreateContext, injectUserData, closeSession } from '../src/lib/steel';

interface FingerprintData {
  navigator: {
    userAgent: string;
    platform: string;
    language: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number | null;
    maxTouchPoints: number;
    vendor: string;
    doNotTrack: string | null;
  };
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    fullVersionList: Array<{ brand: string; version: string }>;
  } | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
  };
  connection: {
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
  } | null;
  webgl: {
    vendor: string;
    renderer: string;
  };
  timezone: string;
  timezoneOffset: number;
}

interface ValidationResult {
  category: string;
  property: string;
  expected: string;
  actual: string;
  match: boolean;
}

async function main() {
  const userId = process.argv[2];

  if (!userId) {
    // Try to find a user with a fingerprint
    const integration = await prisma.integration.findFirst({
      where: { name: 'browser_fingerprint' },
      select: { userId: true }
    });

    if (!integration) {
      console.error('❌ No user with fingerprint found. Please provide userId or upload a fingerprint first.');
      process.exit(1);
    }

    console.log(`📋 Using userId from DB: ${integration.userId}`);
    return runTest(integration.userId);
  }

  return runTest(userId);
}

async function runTest(userId: string) {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 FINGERPRINT SYNC VALIDATION TEST');
  console.log('='.repeat(80) + '\n');

  // 1. Load expected fingerprint
  console.log('📥 Loading stored fingerprint...');
  const integration = await prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name: 'browser_fingerprint', accountId: '' } },
  });

  if (!integration) {
    console.error(`❌ No fingerprint found for user ${userId}`);
    process.exit(1);
  }

  const fp = (integration.config as { fingerprint?: FingerprintData })?.fingerprint;
  if (!fp) {
    console.error('❌ Fingerprint data is empty');
    process.exit(1);
  }

  console.log('✅ Fingerprint loaded');
  console.log(`   Platform: ${fp.userAgentData?.platform || 'N/A'}`);
  console.log(`   UA: ${fp.navigator.userAgent.substring(0, 60)}...`);
  console.log(`   Timezone: ${fp.timezone}`);

  // 2. Create Steel session
  console.log('\n📡 Creating Steel session...');
  const contextId = await getOrCreateContext(userId);
  const { sessionId, wsUrl, debugUrl } = await createSessionWithContext(contextId, 'test-fingerprint-sync');

  console.log('✅ Session created');
  console.log(`   Session ID: ${sessionId}`);
  console.log(`   Debug URL: ${debugUrl}`);

  // 3. Inject fingerprint
  console.log('\n💉 Injecting fingerprint data...');
  const injectionResult = await injectUserData(sessionId, userId);
  console.log('✅ Injection complete');
  console.log(`   Cookies: ${injectionResult.cookies.cookieCount}`);
  console.log(`   Fingerprint: ${injectionResult.fingerprint.injected}`);

  // 4. Connect via Playwright and run validations
  console.log('\n🔌 Connecting to browser via CDP...');
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  const results: ValidationResult[] = [];

  try {
    // IMPORTANT: Re-apply fingerprint settings since we have a new CDP connection
    // The init scripts added in injectUserData() were lost when we closed that connection
    console.log('\n🔧 Re-applying fingerprint settings for this CDP connection...');

    // Create CDP session for this test connection
    const cdpSession = await context.newCDPSession(page);

    // Test: Try Network.enable first (might be required)
    console.log('   Enabling Network domain...');
    await cdpSession.send('Network.enable');

    // Re-apply Network.setUserAgentOverride with full metadata
    if (fp.userAgentData) {
      console.log('   Setting Network.setUserAgentOverride with userAgentMetadata...');
      const userAgentOverrideParams = {
        userAgent: fp.navigator.userAgent,
        acceptLanguage: fp.navigator.languages.join(','),
        platform: fp.navigator.platform,
        userAgentMetadata: {
          brands: fp.userAgentData.brands,
          fullVersionList: fp.userAgentData.fullVersionList,
          platform: fp.userAgentData.platform,
          platformVersion: fp.userAgentData.platformVersion,
          architecture: fp.userAgentData.architecture,
          model: fp.userAgentData.model,
          mobile: fp.userAgentData.mobile,
          bitness: fp.userAgentData.bitness,
        },
      };
      await cdpSession.send('Network.setUserAgentOverride', userAgentOverrideParams as any);
      console.log(`   ✅ Set userAgentMetadata: platform=${fp.userAgentData.platform}, arch=${fp.userAgentData.architecture}`);
    }

    // Re-add the fingerprint init script
    console.log('   Adding fingerprint init script...');
    const fingerprintScript = `
      (function() {
        'use strict';
        const fp = ${JSON.stringify(fp)};

        // Override navigator properties
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => fp.navigator.platform, configurable: true });
        Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => fp.navigator.userAgent, configurable: true });
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => fp.navigator.hardwareConcurrency, configurable: true });
        Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => fp.navigator.deviceMemory, configurable: true });
        Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });

        // Override screen
        Object.defineProperty(Screen.prototype, 'width', { get: () => fp.screen.width, configurable: true });
        Object.defineProperty(Screen.prototype, 'height', { get: () => fp.screen.height, configurable: true });

        // Override userAgentData
        if (fp.userAgentData) {
          Object.defineProperty(Navigator.prototype, 'userAgentData', {
            get: () => ({
              brands: fp.userAgentData.brands,
              mobile: fp.userAgentData.mobile,
              platform: fp.userAgentData.platform,
              getHighEntropyValues: async (hints) => {
                const result = { brands: fp.userAgentData.brands, mobile: fp.userAgentData.mobile, platform: fp.userAgentData.platform };
                if (hints.includes('platformVersion')) result.platformVersion = fp.userAgentData.platformVersion;
                if (hints.includes('architecture')) result.architecture = fp.userAgentData.architecture;
                if (hints.includes('bitness')) result.bitness = fp.userAgentData.bitness;
                return result;
              },
            }),
            configurable: true,
          });
        }

        console.log('[Fingerprint Test] Init script applied');
      })();
    `;
    await context.addInitScript(fingerprintScript);
    console.log('   ✅ Init script added');

    // Test 1: Check JS-level values directly
    console.log('\n' + '-'.repeat(60));
    console.log('📊 TEST 1: JavaScript API Values');
    console.log('-'.repeat(60));

    // Navigate to about:blank to trigger init script
    await page.goto('about:blank');
    await page.waitForTimeout(500);

    const jsValues = await page.evaluate(`
      (async function() {
        var nav = navigator;

        // Get high entropy values if available
        var highEntropyValues = null;
        try {
          if (nav.userAgentData && nav.userAgentData.getHighEntropyValues) {
            highEntropyValues = await nav.userAgentData.getHighEntropyValues([
              'platform', 'platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList'
            ]);
          }
        } catch (e) {
          console.error('Failed to get high entropy values:', e);
        }

        return {
          userAgent: nav.userAgent,
          platform: nav.platform,
          language: nav.language,
          languages: Array.from(nav.languages),
          hardwareConcurrency: nav.hardwareConcurrency,
          deviceMemory: nav.deviceMemory,
          maxTouchPoints: nav.maxTouchPoints,
          vendor: nav.vendor,
          doNotTrack: nav.doNotTrack,
          webdriver: nav.webdriver,
          userAgentData: nav.userAgentData ? {
            brands: nav.userAgentData.brands,
            mobile: nav.userAgentData.mobile,
            platform: nav.userAgentData.platform,
          } : null,
          highEntropyValues: highEntropyValues,
          screen: {
            width: screen.width,
            height: screen.height,
            colorDepth: screen.colorDepth,
            devicePixelRatio: window.devicePixelRatio,
          },
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          timezoneOffset: new Date().getTimezoneOffset(),
        };
      })()
    `) as any;

    // Compare JS values
    results.push({
      category: 'JS Navigator',
      property: 'navigator.platform',
      expected: fp.navigator.platform,
      actual: jsValues.platform,
      match: jsValues.platform === fp.navigator.platform,
    });

    results.push({
      category: 'JS Navigator',
      property: 'navigator.userAgent',
      expected: fp.navigator.userAgent.substring(0, 50) + '...',
      actual: jsValues.userAgent.substring(0, 50) + '...',
      match: jsValues.userAgent === fp.navigator.userAgent,
    });

    results.push({
      category: 'JS Navigator',
      property: 'navigator.webdriver',
      expected: 'false',
      actual: String(jsValues.webdriver),
      match: jsValues.webdriver === false,
    });

    results.push({
      category: 'JS Navigator',
      property: 'navigator.hardwareConcurrency',
      expected: String(fp.navigator.hardwareConcurrency),
      actual: String(jsValues.hardwareConcurrency),
      match: jsValues.hardwareConcurrency === fp.navigator.hardwareConcurrency,
    });

    if (fp.userAgentData && jsValues.userAgentData) {
      results.push({
        category: 'JS UserAgentData',
        property: 'userAgentData.platform',
        expected: fp.userAgentData.platform,
        actual: jsValues.userAgentData.platform,
        match: jsValues.userAgentData.platform === fp.userAgentData.platform,
      });
    }

    if (fp.userAgentData && jsValues.highEntropyValues) {
      results.push({
        category: 'JS UserAgentData',
        property: 'getHighEntropyValues().platform',
        expected: fp.userAgentData.platform,
        actual: jsValues.highEntropyValues.platform,
        match: jsValues.highEntropyValues.platform === fp.userAgentData.platform,
      });

      results.push({
        category: 'JS UserAgentData',
        property: 'getHighEntropyValues().architecture',
        expected: fp.userAgentData.architecture,
        actual: jsValues.highEntropyValues.architecture,
        match: jsValues.highEntropyValues.architecture === fp.userAgentData.architecture,
      });
    }

    results.push({
      category: 'JS Screen',
      property: 'screen.width',
      expected: String(fp.screen.width),
      actual: String(jsValues.screen.width),
      match: jsValues.screen.width === fp.screen.width,
    });

    results.push({
      category: 'JS Timezone',
      property: 'timezone',
      expected: fp.timezone,
      actual: jsValues.timezone,
      match: jsValues.timezone === fp.timezone,
    });

    results.push({
      category: 'JS Timezone',
      property: 'timezoneOffset',
      expected: String(fp.timezoneOffset),
      actual: String(jsValues.timezoneOffset),
      match: jsValues.timezoneOffset === fp.timezoneOffset,
    });

    // Test 2: Check HTTP headers via browserleaks
    console.log('\n' + '-'.repeat(60));
    console.log('📊 TEST 2: HTTP Headers (via browserleaks.com/client-hints)');
    console.log('-'.repeat(60));

    await page.goto('https://browserleaks.com/client-hints', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Extract header values from the page
    const httpHeaders = await page.evaluate(`
      (function() {
        function getTableValue(headerName) {
          const rows = document.querySelectorAll('table tr');
          for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
              const label = cells[0].textContent ? cells[0].textContent.trim() : '';
              if (label === headerName) {
                return cells[1].textContent ? cells[1].textContent.trim() : null;
              }
            }
          }
          return null;
        }

        return {
          userAgent: getTableValue('User-Agent'),
          secChUa: getTableValue('Sec-CH-UA'),
          secChUaPlatform: getTableValue('Sec-CH-UA-Platform'),
          secChUaPlatformVersion: getTableValue('Sec-CH-UA-Platform-Version'),
          secChUaArch: getTableValue('Sec-CH-UA-Arch'),
          secChUaBitness: getTableValue('Sec-CH-UA-Bitness'),
          secChUaMobile: getTableValue('Sec-CH-UA-Mobile'),
          secChUaModel: getTableValue('Sec-CH-UA-Model'),
        };
      })()
    `) as any;

    console.log('   Raw HTTP headers from page:');
    console.log(`   - Sec-CH-UA-Platform: ${httpHeaders.secChUaPlatform}`);
    console.log(`   - Sec-CH-UA-Arch: ${httpHeaders.secChUaArch}`);
    console.log(`   - Sec-CH-UA-Bitness: ${httpHeaders.secChUaBitness}`);

    if (fp.userAgentData) {
      const expectedPlatform = `"${fp.userAgentData.platform}"`;
      results.push({
        category: 'HTTP Header',
        property: 'Sec-CH-UA-Platform',
        expected: expectedPlatform,
        actual: httpHeaders.secChUaPlatform || 'NOT SENT',
        match: httpHeaders.secChUaPlatform === expectedPlatform,
      });

      const expectedArch = `"${fp.userAgentData.architecture}"`;
      results.push({
        category: 'HTTP Header',
        property: 'Sec-CH-UA-Arch',
        expected: expectedArch,
        actual: httpHeaders.secChUaArch || 'NOT SENT',
        match: httpHeaders.secChUaArch === expectedArch,
      });

      const expectedBitness = `"${fp.userAgentData.bitness}"`;
      results.push({
        category: 'HTTP Header',
        property: 'Sec-CH-UA-Bitness',
        expected: expectedBitness,
        actual: httpHeaders.secChUaBitness || 'NOT SENT',
        match: httpHeaders.secChUaBitness === expectedBitness,
      });
    }

    // Test 3: WebRTC leak check
    console.log('\n' + '-'.repeat(60));
    console.log('📊 TEST 3: WebRTC Leak Check');
    console.log('-'.repeat(60));

    await page.goto('https://browserleaks.com/webrtc', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    const webrtcInfo = await page.evaluate(`
      (function() {
        // Look for IP addresses on the page
        var pageText = document.body.innerText;
        var ipPattern = /\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g;
        var ips = pageText.match(ipPattern) || [];

        return {
          publicIps: Array.from(new Set(ips)),
          leakDetected: pageText.toLowerCase().includes('leak') && !pageText.toLowerCase().includes('no leak'),
        };
      })()
    `) as any;

    console.log(`   Detected IPs: ${webrtcInfo.publicIps.join(', ') || 'none'}`);
    console.log(`   Leak detected: ${webrtcInfo.leakDetected}`);

    // Test 4: Bot detection check
    console.log('\n' + '-'.repeat(60));
    console.log('📊 TEST 4: Bot Detection (bot.sannysoft.com)');
    console.log('-'.repeat(60));

    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const botCheckResults = await page.evaluate(`
      (function() {
        var results = [];
        var rows = document.querySelectorAll('table tr');

        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var cells = row.querySelectorAll('td');
          if (cells.length >= 2) {
            var testName = cells[0].textContent ? cells[0].textContent.trim() : '';
            var resultCell = cells[1];
            var passed = resultCell.classList.contains('passed') ||
                          (resultCell.textContent && resultCell.textContent.toLowerCase().includes('passed')) ||
                          resultCell.style.backgroundColor === 'green' ||
                          resultCell.style.backgroundColor === 'rgb(0, 128, 0)';

            if (testName) {
              results.push({ test: testName, passed: !!passed });
            }
          }
        }

        return results;
      })()
    `) as any;

    const failedBotTests = botCheckResults.filter(r => !r.passed);
    console.log(`   Total tests: ${botCheckResults.length}`);
    console.log(`   Passed: ${botCheckResults.length - failedBotTests.length}`);
    console.log(`   Failed: ${failedBotTests.length}`);

    if (failedBotTests.length > 0) {
      console.log('   Failed tests:');
      for (const test of failedBotTests.slice(0, 5)) {
        console.log(`     - ${test.test}`);
      }
    }

    results.push({
      category: 'Bot Detection',
      property: 'sannysoft bot tests',
      expected: '0 failed',
      actual: `${failedBotTests.length} failed`,
      match: failedBotTests.length === 0,
    });

  } finally {
    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await browser.close();
    await closeSession(sessionId);
  }

  // Print results summary
  console.log('\n' + '='.repeat(80));
  console.log('📋 VALIDATION RESULTS SUMMARY');
  console.log('='.repeat(80) + '\n');

  const passed = results.filter(r => r.match);
  const failed = results.filter(r => !r.match);

  console.log(`✅ PASSED: ${passed.length}/${results.length}`);
  console.log(`❌ FAILED: ${failed.length}/${results.length}`);

  if (failed.length > 0) {
    console.log('\n❌ FAILED CHECKS:');
    console.log('-'.repeat(60));
    for (const result of failed) {
      console.log(`\n[${result.category}] ${result.property}`);
      console.log(`  Expected: ${result.expected}`);
      console.log(`  Actual:   ${result.actual}`);
    }
  }

  console.log('\n✅ PASSED CHECKS:');
  console.log('-'.repeat(60));
  for (const result of passed) {
    console.log(`[${result.category}] ${result.property}: ${result.actual}`);
  }

  // Exit with error code if any critical failures
  const criticalFailures = failed.filter(r =>
    r.property.includes('Sec-CH-UA-Platform') ||
    r.property === 'navigator.webdriver' ||
    r.property === 'navigator.platform'
  );

  if (criticalFailures.length > 0) {
    console.log('\n⚠️  CRITICAL FAILURES DETECTED');
    process.exit(1);
  }

  console.log('\n✅ All critical checks passed!');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('❌ Test failed with error:', e);
  await prisma.$disconnect();
  process.exit(1);
});

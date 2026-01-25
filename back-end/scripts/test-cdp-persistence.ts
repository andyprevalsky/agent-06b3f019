/**
 * Test CDP setting persistence across connections.
 *
 * This tests whether Network.setUserAgentOverride and init scripts persist
 * when we close the CDP connection and open a new one.
 *
 * Usage: npx tsx back-end/scripts/test-cdp-persistence.ts
 */

import { chromium } from 'playwright';
import { prisma } from '../src/lib/prisma';
import { createSessionWithContext, getOrCreateContext, injectUserData, closeSession } from '../src/lib/steel';

async function main() {
  console.log('\n' + '='.repeat(80));
  console.log('🧪 CDP PERSISTENCE TEST');
  console.log('='.repeat(80) + '\n');

  // 1. Get a user with fingerprint
  const integration = await prisma.integration.findFirst({
    where: { name: 'browser_fingerprint' },
  });

  if (!integration) {
    console.error('❌ No fingerprint found');
    process.exit(1);
  }

  const userId = integration.userId;
  const fp = (integration.config as any)?.fingerprint;
  console.log(`📋 User: ${userId}`);
  console.log(`📋 Expected platform: ${fp?.userAgentData?.platform || 'N/A'}`);

  // 2. Create Steel session
  console.log('\n📡 Creating Steel session...');
  const contextId = await getOrCreateContext(userId);
  const { sessionId, wsUrl } = await createSessionWithContext(contextId, 'test-persistence');
  console.log(`✅ Session: ${sessionId}`);

  // 3. Inject fingerprint (this applies settings then CLOSES the connection)
  console.log('\n💉 Running injectUserData() (will close CDP connection)...');
  await injectUserData(sessionId, userId);
  console.log('✅ injectUserData complete (CDP connection closed)');

  // 4. Open a NEW CDP connection (simulating what the Python agent does)
  console.log('\n🔌 Opening NEW CDP connection (like Python agent would)...');
  const browser = await chromium.connectOverCDP(wsUrl);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();

  // 5. Navigate to browserleaks WITHOUT re-applying any settings
  console.log('\n📊 Navigating to browserleaks (NO settings re-applied)...');
  await page.goto('https://browserleaks.com/client-hints', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 6. Check what we got
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
        secChUaPlatform: getTableValue('Sec-CH-UA-Platform'),
        secChUaArch: getTableValue('Sec-CH-UA-Arch'),
      };
    })()
  `) as any;

  const jsValues = await page.evaluate(`
    (function() {
      return {
        platform: navigator.platform,
        userAgentDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
      };
    })()
  `) as any;

  console.log('\n' + '='.repeat(60));
  console.log('📋 RESULTS (without re-applying settings):');
  console.log('='.repeat(60));
  console.log(`\nHTTP Sec-CH-UA-Platform: ${httpHeaders.secChUaPlatform}`);
  console.log(`HTTP Sec-CH-UA-Arch: ${httpHeaders.secChUaArch}`);
  console.log(`JS navigator.platform: ${jsValues.platform}`);
  console.log(`JS userAgentData.platform: ${jsValues.userAgentDataPlatform}`);

  const platformOk = httpHeaders.secChUaPlatform === `"${fp?.userAgentData?.platform}"`;
  const archOk = httpHeaders.secChUaArch === `"${fp?.userAgentData?.architecture}"`;
  const jsPlatformOk = jsValues.platform === fp?.navigator?.platform;

  console.log('\n' + '='.repeat(60));
  console.log('📋 PERSISTENCE CHECK:');
  console.log('='.repeat(60));
  console.log(`HTTP headers persisted: ${platformOk && archOk ? '✅ YES' : '❌ NO'}`);
  console.log(`JS init scripts persisted: ${jsPlatformOk ? '✅ YES' : '❌ NO'}`);

  if (!platformOk || !archOk || !jsPlatformOk) {
    console.log('\n⚠️  CDP settings do NOT persist across connections.');
    console.log('   Settings must be re-applied when a new CDP connection is made.');
  }

  // Cleanup
  await browser.close();
  await closeSession(sessionId);
  await prisma.$disconnect();
}

main().catch(console.error);

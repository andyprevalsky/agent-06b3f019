/**
 * Test script to debug cookie injection into Playwright
 * 
 * Usage: npx ts-node scripts/test-cookie-injection.ts
 */

import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface StoredCookie {
  host_key: string;
  name: string;
  value: string;
  path: string;
  expires_utc: number;
  is_secure: boolean;
  is_httponly: boolean;
}

async function main() {
  console.log('🍪 Cookie Injection Test Script\n');

  // 1. Fetch cookies from database
  console.log('1. Fetching cookies from database...');
  const integration = await prisma.integration.findFirst({
    where: { name: 'chrome_cookies' },
    select: { config: true, userId: true }
  });

  if (!integration?.config) {
    console.error('❌ No chrome_cookies integration found');
    return;
  }

  const config = integration.config as { cookies?: StoredCookie[] };
  const cookies = config.cookies || [];
  console.log(`   Found ${cookies.length} cookies\n`);

  // 2. Launch local Playwright browser
  console.log('2. Launching Playwright browser...');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  console.log('   Browser launched\n');

  // 3. Transform cookies to Playwright format
  console.log('3. Transforming cookies to Playwright format...');
  
  const CHROME_EPOCH_OFFSET = 11644473600;
  
  const playwrightCookies = cookies.map((cookie: StoredCookie) => {
    // Convert expiry
    let expires: number | undefined;
    if (cookie.expires_utc && cookie.expires_utc > 0) {
      expires = Math.floor(cookie.expires_utc / 1000000) - CHROME_EPOCH_OFFSET;
      if (expires < Date.now() / 1000) {
        expires = undefined; // Expired, make it a session cookie
      }
    }

    // Keep domain as-is - Playwright handles leading dots correctly
    // Leading dot means "apply to all subdomains" which is what we want
    let domain = cookie.host_key;

    // Determine sameSite - if secure is false, can't use "None"
    let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
    
    return {
      name: cookie.name,
      value: cookie.value,
      domain: domain,
      path: cookie.path || '/',
      expires,
      secure: cookie.is_secure,
      httpOnly: cookie.is_httponly,
      sameSite,
    };
  });

  // Filter out cookies with missing required fields or invalid values
  // Some cookies fail decryption and have garbage - skip them
  const isValidValue = (str: string): boolean => {
    if (!str || str.length === 0) return false;
    // Check for non-printable characters (control chars, etc)
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code < 32 || code > 126) {
        // Allow only printable ASCII
        return false;
      }
    }
    return true;
  };

  const validCookies = playwrightCookies.filter(c => {
    if (!c.name || !c.value) return false;
    if (!c.domain) return false;
    if (!isValidValue(c.value)) return false;
    return true;
  });
  
  console.log(`   Valid cookies: ${validCookies.length} (filtered ${playwrightCookies.length - validCookies.length} with invalid values)`);

  console.log(`   Transformed ${validCookies.length} valid cookies\n`);

  // 4. Try injecting cookies one by one to find problematic ones
  console.log('4. Injecting cookies (testing individually first)...');
  
  // Test with first 10 cookies individually
  let successCount = 0;
  let failCount = 0;
  const failedCookies: { cookie: any; error: string }[] = [];

  for (let i = 0; i < Math.min(10, validCookies.length); i++) {
    const cookie = validCookies[i];
    try {
      await context.addCookies([cookie]);
      successCount++;
      console.log(`   ✅ Cookie ${i}: ${cookie.name} (${cookie.domain})`);
    } catch (error) {
      failCount++;
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`   ❌ Cookie ${i}: ${cookie.name} (${cookie.domain}) - ${errMsg}`);
      failedCookies.push({ cookie, error: errMsg });
    }
  }

  console.log(`\n   Individual test: ${successCount} success, ${failCount} failed\n`);

  // 5. If individual cookies work, try batch injection
  if (successCount > 0) {
    console.log('5. Attempting batch injection of all cookies...');
    
    // Create a new context for clean test
    const context2 = await browser.newContext();
    
    const BATCH_SIZE = 50;
    let totalInjected = 0;
    let batchErrors = 0;

    for (let i = 0; i < validCookies.length; i += BATCH_SIZE) {
      const batch = validCookies.slice(i, i + BATCH_SIZE);
      try {
        await context2.addCookies(batch);
        totalInjected += batch.length;
        process.stdout.write(`   Batch ${Math.floor(i / BATCH_SIZE) + 1}: ✅ (${batch.length} cookies)\n`);
      } catch (error) {
        batchErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        process.stdout.write(`   Batch ${Math.floor(i / BATCH_SIZE) + 1}: ❌ ${errMsg}\n`);
        
        // Try to find the problematic cookie in this batch
        for (const cookie of batch) {
          try {
            await context2.addCookies([cookie]);
          } catch (singleErr) {
            console.log(`      Bad cookie: ${cookie.name} @ ${cookie.domain}`);
            console.log(`      Value preview: ${cookie.value.substring(0, 50)}...`);
            break; // Found one bad cookie, move on
          }
        }
      }
    }

    console.log(`\n   Total injected: ${totalInjected}/${validCookies.length}`);
    console.log(`   Batch errors: ${batchErrors}\n`);
    
    await context2.close();
  }

  // 6. Test navigation to Amazon with injected cookies
  console.log('6. Testing Amazon login state...');
  
  // Create fresh context and inject ALL cookies
  const amazonContext = await browser.newContext();
  await amazonContext.addCookies(validCookies);
  
  const amazonPage = await amazonContext.newPage();
  await amazonPage.goto('https://www.amazon.com', { timeout: 60000 });
  await amazonPage.waitForLoadState('domcontentloaded');
  await amazonPage.waitForTimeout(3000); // Wait for dynamic content
  
  // Check if logged in by looking for account name
  const accountText = await amazonPage.locator('#nav-link-accountList-nav-line-1').textContent().catch(() => null);
  console.log(`   Amazon account status: ${accountText || 'Not found'}`);
  
  // Also check for "Hello, [Name]" pattern
  const helloText = await amazonPage.locator('#nav-link-accountList').textContent().catch(() => null);
  console.log(`   Full account widget: ${helloText?.replace(/\s+/g, ' ').trim() || 'Not found'}\n`);
  
  // Take screenshot
  await amazonPage.screenshot({ path: 'cookie-test-screenshot.png', fullPage: false });
  console.log('   Screenshot saved to cookie-test-screenshot.png\n');
  
  await amazonContext.close();

  // 7. Show sample of problematic cookies
  if (failedCookies.length > 0) {
    console.log('7. Sample of failed cookies:');
    for (const { cookie, error } of failedCookies.slice(0, 3)) {
      console.log(`   Name: ${cookie.name}`);
      console.log(`   Domain: ${cookie.domain}`);
      console.log(`   Path: ${cookie.path}`);
      console.log(`   Secure: ${cookie.secure}`);
      console.log(`   HttpOnly: ${cookie.httpOnly}`);
      console.log(`   SameSite: ${cookie.sameSite}`);
      console.log(`   Value length: ${cookie.value?.length}`);
      console.log(`   Error: ${error}`);
      console.log('');
    }
  }

  console.log('Closing browser in 5 seconds...');
  await new Promise(resolve => setTimeout(resolve, 5000));
  await browser.close();
  console.log('Done!');
}

main().catch(console.error).finally(() => prisma.$disconnect());


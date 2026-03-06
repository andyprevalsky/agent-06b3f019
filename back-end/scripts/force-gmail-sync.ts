import 'dotenv/config';

// Use DIRECT_URL if transaction pooler (6543) is down
if (process.env.DIRECT_URL) process.env.DATABASE_URL = process.env.DIRECT_URL;

async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { EmailProvider } = await import('@prisma/client');
  const { fetchGmailEmails, parseGmailOAuthEmails } = await import('../src/services/integrations/gmailParser');

  const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

  // Parse CLI args
  const email = process.argv[2];
  const forceFlag = process.argv.includes('--force');

  if (!email) {
    console.error('Usage: npx tsx back-end/scripts/force-gmail-sync.ts <email> [--force]');
    console.error('  --force: Clear existing email data before sync');
    process.exit(1);
  }

  async function refreshAccessToken(refreshToken: string): Promise<string> {
    const clientId = process.env.GMAIL_WEB_CLIENT_ID;
    const clientSecret = process.env.GMAIL_WEB_CLIENT_SECRET;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId!,
      ...(clientSecret && { client_secret: clientSecret }),
    });
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json() as any;
    if (!data.access_token) throw new Error('Failed to refresh: ' + JSON.stringify(data));
    return data.access_token;
  }

  const credential = await prisma.emailIntegrationCredential.findFirst({
    where: { provider: EmailProvider.GMAIL, email },
  });
  if (!credential?.refreshToken) {
    console.error(`No Gmail credential found for ${email}`);
    process.exit(1);
  }

  const userId = credential.userId;
  const accessToken = await refreshAccessToken(credential.refreshToken);
  const userEmail = credential.email || email;

  console.log(`User: ${userId}, Email: ${userEmail}`);

  if (forceFlag) {
    const msgs = await prisma.messageRecord.deleteMany({ where: { person: { userId }, channel: 'EMAIL' } });
    const persons = await prisma.person.deleteMany({ where: { userId, email: { not: null } } });
    console.log(`Cleared: ${msgs.count} messages, ${persons.count} persons`);
  }

  // Full sync with timing
  const startTime = Date.now();
  console.log('\nFetching all emails...');
  const emails = await fetchGmailEmails(accessToken, userEmail);
  const fetchTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nFetch complete: ${emails.length} emails in ${fetchTime}s`);

  console.log('\n=== Running sync ===');
  const jobId = `force-sync-${Date.now()}`;
  const result = await parseGmailOAuthEmails(userId, userEmail, emails, jobId);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n=== RESULTS ===`);
  console.log(`Total contacts: ${result.contacts}`);
  console.log(`Total messages: ${result.messages}`);
  console.log(`Total time: ${totalTime}s`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });

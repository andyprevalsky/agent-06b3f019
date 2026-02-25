#!/usr/bin/env tsx
/**
 * Dump token counts for the SMS supervisor context.
 * Uses tiktoken-like estimation (1 token ≈ 4 chars).
 */

import 'dotenv/config';
import { buildSmsContext } from '../src/lib/smsSupervisor/contextBuilder';

const USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30'; // Andy

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

async function main() {
  console.log('Building SMS supervisor context for user...\n');

  const { systemPrompt, sessionHistory } = await buildSmsContext(USER_ID);

  // Split system prompt into sections
  const sections = systemPrompt.split(/^## /m);
  const sectionMap: Record<string, string> = {};
  for (const section of sections) {
    const firstLine = section.split('\n')[0].trim();
    if (firstLine) {
      sectionMap[firstLine] = section;
    }
  }

  console.log('=== SMS SUPERVISOR CONTEXT TOKEN BREAKDOWN ===\n');

  let totalTokens = 0;

  // System prompt total
  const systemTokens = estimateTokens(systemPrompt);
  totalTokens += systemTokens;
  console.log(`System prompt total:           ${systemTokens.toLocaleString()} tokens (${systemPrompt.length.toLocaleString()} chars)`);
  console.log('');

  // Per-section breakdown
  for (const [name, content] of Object.entries(sectionMap)) {
    const tokens = estimateTokens(content);
    const lines = content.split('\n').length;
    console.log(`  ${name.padEnd(35)} ${tokens.toLocaleString().padStart(6)} tokens  (${lines} lines)`);
  }

  console.log('');

  // Session history
  const sessionChars = sessionHistory.reduce((acc, m) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const sessionTokens = estimateTokens(sessionChars.toString()) > 0 ? Math.ceil(sessionChars / 4) : 0;
  totalTokens += sessionTokens;
  console.log(`Session history:               ${sessionTokens.toLocaleString()} tokens (${sessionHistory.length} messages, ${sessionChars.toLocaleString()} chars)`);

  console.log('');
  console.log(`TOTAL ESTIMATED TOKENS:        ${totalTokens.toLocaleString()} tokens`);
  console.log('');

  // Show the actual system prompt
  console.log('=== FULL SYSTEM PROMPT ===\n');
  console.log(systemPrompt);
  console.log('\n=== SESSION HISTORY ===\n');
  if (sessionHistory.length === 0) {
    console.log('(empty — no prior SMS session)');
  } else {
    for (const msg of sessionHistory) {
      console.log(`[${msg.role}] ${typeof msg.content === 'string' ? msg.content.substring(0, 200) : '...'}`);
    }
  }
}

main().catch(console.error).finally(() => {
  // Give prisma time to disconnect
  setTimeout(() => process.exit(0), 500);
});

#!/usr/bin/env tsx
/* eslint-disable no-console */

/**
 * AgentCard "for companies" LIVE sandbox verification.
 *
 * Prereq: the target user has completed "Connect with AgentCard" via
 *   GET ${AGENTCARD_PUBLIC_URL}/api/agentcard/connect?user=<userId>
 * so a per-user token is stored (Integration name="agentcard").
 *
 * Usage:
 *   tsx scripts/agentcard-verify.ts <userId>            # list live tools + list_cards (read-only)
 *   tsx scripts/agentcard-verify.ts <userId> --create   # also issue ONE sandbox card, then re-verify
 *
 * Never prints PAN/CVV.
 */

import dotenv from 'dotenv';
dotenv.config();

import { getStatus } from '../src/domains/agentcard/service';
import { callUserTool, listUserTools } from '../src/providers/agentcard/runtime';

/** Extract a plain object from an MCP tool result (structuredContent or JSON text). */
function unwrap(result: unknown): Record<string, unknown> {
  const r = result as {
    structuredContent?: unknown;
    content?: Array<{ type: string; text?: string }>;
  };
  if (r.structuredContent && typeof r.structuredContent === 'object') {
    return r.structuredContent as Record<string, unknown>;
  }
  const text = (r.content ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return { _text: text };
}

const SENSITIVE_KEY = /pan|card_number|cardnumber|number|cvv|cvc|security_code/i;

/**
 * Redact anything that looks like a card number / CVV before logging. Recurses
 * through nested objects and arrays, and redacts the `_text` unstructured
 * fallback so raw MCP text (which may embed a PAN/CVV) is never printed.
 */
function safe(value: unknown, key = ''): unknown {
  if (key === '_text' || SENSITIVE_KEY.test(key)) return '***';
  if (Array.isArray(value)) return value.map((item) => safe(item));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        safe(childValue, childKey),
      ])
    );
  }
  return value;
}

async function main(): Promise<void> {
  const userId = process.argv[2];
  const doCreate = process.argv.includes('--create');
  if (userId === undefined || userId === '') {
    console.error('Usage: tsx scripts/agentcard-verify.ts <userId> [--create]');
    process.exit(1);
  }

  console.log(`\n== AgentCard live verification for user ${userId} ==`);
  const status = await getStatus(userId);
  console.log('status:', status);
  if (!status.connected) {
    console.error(
      `\nUser is not connected. Have them open:\n  ${process.env.AGENTCARD_PUBLIC_URL}/api/agentcard/connect?user=${encodeURIComponent(userId)}\n`
    );
    process.exit(2);
  }

  // Part 3: the FULL live toolset (dynamic — whatever the server advertises).
  const tools = await listUserTools(userId);
  console.log(`\nlive tools (${tools.length}):`, tools.map((t) => t.name).join(', '));
  const names = new Set(tools.map((t) => t.name));

  if (doCreate && names.has('create_card')) {
    console.log('\ncreating ONE sandbox card (amount_cents=100)...');
    let created = unwrap(await callUserTool(userId, 'create_card', { amount_cents: 100 }));
    // Approval gate: resolve with approve_request if required.
    if (created.approval_required === true && typeof created.approval_id === 'string') {
      console.log('approval required, resolving via approve_request:', created.approval_id);
      await callUserTool(userId, 'approve_request', { approval_id: created.approval_id });
      created = unwrap(await callUserTool(userId, 'create_card', { amount_cents: 100 }));
    }
    console.log('create_card ->', safe(created));
  }

  // Independent verification: list the user's cards directly via MCP.
  if (names.has('list_cards')) {
    const cards = unwrap(await callUserTool(userId, 'list_cards', {}));
    console.log('\nlist_cards ->', safe(cards));
  }
  if (names.has('get_plan')) {
    const plan = unwrap(await callUserTool(userId, 'get_plan', {}));
    console.log('get_plan ->', safe(plan));
  }

  console.log('\n✅ AgentCard live verification complete');
}

main().catch((err) => {
  console.error('verification failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

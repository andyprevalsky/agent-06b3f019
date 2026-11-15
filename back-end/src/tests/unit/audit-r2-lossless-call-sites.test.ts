#!/usr/bin/env tsx
/**
 * The lossless audit (scripts/audit-r2-lossless.ts, check C6) must recognize
 * every backend call site that archives LLM records; an unmapped name makes
 * the audit unable to verify that call site at all.
 */
import assert from 'node:assert/strict';
import { FAMILY_ALIASES } from '../../../scripts/audit-r2-lossless-core';
import { BACKEND_CALL_SITES } from '../../../scripts/audit-r2-lossless-engine';

/** Backend call sites that write v2 records (providers/llmArchiveRecord + dump_context callers). */
const ARCHIVED_BACKEND_CALL_SITES = [
  'chat_router',
  'chat_router_after_search',
  'chat_generator',
  'chat_compaction',
  'response_schema_generation',
  'llm_judge_prompt_generation',
  'sms_supervisor',
  'sms_notification',
  'sms_voice_note_stt',
  'phone_setup_identity',
  'phone_setup_runtime',
  'phone_message_send',
  'phone_message_sent',
  'phone_saved_credential_binding',
  'phone_imessage_auth_loss',
  'challenge_llm_classifier',
  'credential_failure_classifier',
  'purchase_approval_reuse',
  'vapi_hold_human_detector',
  'generate_video',
];

function main(): void {
  const unmapped = ARCHIVED_BACKEND_CALL_SITES.filter((callSite) => {
    const family = FAMILY_ALIASES[callSite] ?? callSite;
    return !BACKEND_CALL_SITES.some(({ match }) => match.test(family));
  });
  assert.deepEqual(unmapped, [], 'every archived backend call site maps to an audit C6 site');
  process.stdout.write('audit-r2-lossless-call-sites: all checks passed\n');
}

main();

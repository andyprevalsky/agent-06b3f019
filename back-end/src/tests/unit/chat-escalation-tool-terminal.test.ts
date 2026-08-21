#!/usr/bin/env tsx

/**
 * Source contract: when chat escalation fails after the Cloud Agent tool is
 * marked IN_PROGRESS (rejected start or acceptance throw), the handler must
 * persist a terminal FINISHED/error tool message and never claim status
 * "escalated". Post-acceptance broadcast failures must not be treated as
 * rejected starts. Unaccepted-workflow cleanup must retry before callers can
 * report a clean rejection.
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const handler = readFileSync(
  join(process.cwd(), 'src', 'providers', 'chat', 'chatHandler.ts'),
  'utf8'
);

const escalationBranch = handler.slice(
  handler.indexOf("if (decision.action === 'start_superintelligence')"),
  handler.indexOf("if (decision.action === 'web_search')")
);

assert.ok(
  escalationBranch.includes("toolStatus: 'IN_PROGRESS'"),
  'escalation must open the Cloud Agent tool as IN_PROGRESS'
);
assert.ok(
  /try\s*\{\s*started\s*=\s*await\s*startTemporalWorkflowForChat/.test(escalationBranch),
  'escalation must catch failures from startTemporalWorkflowForChat'
);
assert.ok(
  escalationBranch.includes('finishRejectedCloudAgentTool'),
  'escalation must terminalize the Cloud Agent tool on failure'
);
assert.ok(
  escalationBranch.includes('workflow acceptance failed'),
  'acceptance-throw path must finish the tool with an acceptance-failure message'
);
assert.ok(
  escalationBranch.includes('no longer eligible to escalate'),
  'false-start path must finish the tool with an ineligibility message'
);
assert.ok(
  /catch\s*\([^)]*\)\s*\{[\s\S]*finishRejectedCloudAgentTool[\s\S]*throw error/.test(
    escalationBranch
  ),
  'start failure must rethrow after attempting to finish the tool'
);
assert.ok(
  /if\s*\(\s*!started\s*\)\s*\{[\s\S]*finishRejectedCloudAgentTool[\s\S]*return\s*\{\s*status:\s*'complete'/.test(
    escalationBranch
  ),
  'rejected start must return complete after finishing the tool'
);
assert.ok(
  /async function finishRejectedCloudAgentTool[\s\S]*toolStatus:\s*'FINISHED'[\s\S]*error:\s*true/.test(
    handler
  ),
  'finishRejectedCloudAgentTool must mark the tool FINISHED with error:true'
);

const startHelper = handler.slice(
  handler.indexOf('async function startTemporalWorkflowForChat'),
  handler.indexOf('async function terminateUnacceptedChatWorkflow')
);
assert.ok(
  /try\s*\{\s*await broadcastAgentModeStarted\(agentId\);[\s\S]*\}\s*catch/.test(startHelper),
  'post-acceptance broadcast must be best-effort and not fail the start'
);
assert.ok(
  startHelper.includes('terminateUnacceptedChatWorkflow'),
  'rejected acceptance must use retried terminate helper'
);
assert.ok(
  /UNACCEPTED_TERMINATE_ATTEMPTS\s*=\s*3/.test(handler),
  'unaccepted workflow cleanup must use a bounded retry budget'
);
assert.ok(
  escalationBranch.includes('Failed to terminalize Cloud Agent tool after start failure'),
  'terminalization failure must be logged without replacing the original error'
);

process.stdout.write('PASS chat escalation finishes Cloud Agent tool on acceptance failure\n');

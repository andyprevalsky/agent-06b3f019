import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isE2bTeamBillingBlockError,
  isLocalClaudeCodeSandboxId,
  shouldAllowLocalClaudeCodeFallback,
} from '../../providers/claudeCodeLocalSession';

test('detects E2B team payment-method blocks', () => {
  assert.equal(
    isE2bTeamBillingBlockError(new Error('403: team is blocked: missing payment method')),
    true
  );
  assert.equal(
    isE2bTeamBillingBlockError(
      new Error('{"message":"team is blocked: missing payment method"}')
    ),
    true
  );
  assert.equal(isE2bTeamBillingBlockError(new Error('redis pool timeout')), false);
});

test('recognizes local sandbox ids', () => {
  assert.equal(isLocalClaudeCodeSandboxId('local-abc'), true);
  assert.equal(isLocalClaudeCodeSandboxId('i-123'), false);
});

test('disables local fallback on Fly by default', () => {
  const prevFly = process.env.FLY_APP_NAME;
  const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
  try {
    delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    process.env.FLY_APP_NAME = 'rose-backend';
    assert.equal(shouldAllowLocalClaudeCodeFallback(), false);
    process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
    assert.equal(shouldAllowLocalClaudeCodeFallback(), true);
  } finally {
    if (prevFly === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = prevFly;
    if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
  }
});

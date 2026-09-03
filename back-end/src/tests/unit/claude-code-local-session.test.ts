import { describe, expect, it } from 'vitest';
import {
  isE2bTeamBillingBlockError,
  isLocalClaudeCodeSandboxId,
  shouldAllowLocalClaudeCodeFallback,
} from '../../providers/claudeCodeLocalSession';

describe('claudeCodeLocalSession billing helpers', () => {
  it('detects E2B team payment-method blocks', () => {
    expect(
      isE2bTeamBillingBlockError(
        new Error('403: team is blocked: missing payment method')
      )
    ).toBe(true);
    expect(
      isE2bTeamBillingBlockError(
        new Error('{"message":"team is blocked: missing payment method"}')
      )
    ).toBe(true);
    expect(isE2bTeamBillingBlockError(new Error('redis pool timeout'))).toBe(false);
  });

  it('recognizes local sandbox ids', () => {
    expect(isLocalClaudeCodeSandboxId('local-abc')).toBe(true);
    expect(isLocalClaudeCodeSandboxId('i-123')).toBe(false);
  });

  it('disables local fallback on Fly by default', () => {
    const prevFly = process.env.FLY_APP_NAME;
    const prevFlag = process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
    try {
      delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
      process.env.FLY_APP_NAME = 'rose-backend';
      expect(shouldAllowLocalClaudeCodeFallback()).toBe(false);
      process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = '1';
      expect(shouldAllowLocalClaudeCodeFallback()).toBe(true);
    } finally {
      if (prevFly === undefined) delete process.env.FLY_APP_NAME;
      else process.env.FLY_APP_NAME = prevFly;
      if (prevFlag === undefined) delete process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK;
      else process.env.CLAUDE_CODE_ALLOW_LOCAL_FALLBACK = prevFlag;
    }
  });
});

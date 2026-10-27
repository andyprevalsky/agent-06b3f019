import {
  testRotation_userRateLimitedFallsBackToPool,
  testRotation_poolRotatesOnRateLimit,
  testComputeRotation_poolRotatesAcrossProviders,
  testComputeTokenLineageSemaphore_capsLiveGptLeases,
} from './integrations.compute-rotation-1.cases';
import {
  testRotation_poolAuthErrorDisablesToken,
  testRotation_userAuthErrorDisablesToken,
  testRotation_directAuthErrorFallsBackToPoolForClaudeCode,
  testRotation_nearExpiryClaudeCodeTokenIsNotServed,
  testComputeTokenFastCacheAffinity_pinsProviderFamily,
  testComputeTokenProviderConstraint_overridesClaudeAffinity,
} from './integrations.compute-rotation-2.cases';
import {
  testRotation_rateLimitWindowIsMonotonic,
  testRotation_gptUserAuthErrorDisablesToken,
  testGptCodeUpload_clearsExpiredAndRateLimitState,
  testRotation_autoExpiresAfterCooldown,
  testRotation_allExhausted404,
  testRotation_defaultCooldownIsBounded,
  testClaudeCodeUpload_clearsRateLimitCooldown,
} from './integrations.compute-rotation-3.cases';
import {
  testAccountPoolDefault_claudeSyncInheritsEnabled,
  testAccountPoolDefault_gptSyncInheritsEnabled,
  testAccountPoolDefault_syncStaysUnpooledWhenDefaultOff,
  testAccountPoolDefault_explicitOverrideWins,
  testAccountPoolDefault_resyncKeepsPooledToken,
} from './integrations.account-pooling-1.cases';
import {
  testClaudeCodeExhaustion_marksPoolToken,
  testClaudeCodeExhaustion_marksUserToken,
  testClaudeCodeExhaustion_noBannerNoOp,
  testClaudeCodeAuthFailure_marksPoolTokenLongCooldown,
  testClaudeCodeRevokedOauth_disablesUserTokenPermanently,
  testClaudeCodeBillingFailure_marksPoolTokenLongCooldown,
  testClaudeCodeBillingFailure_marksSharedAnthropicCooldown,
} from './integrations.claude-lifecycle-1.cases';
import {
  testClaudeCodeSandbox_neverSpendsSharedRefreshGrant,
  testClaudeCodeSandbox_concurrentSessionsShareOneAccessToken,
  testClaudeCodeSandbox_expiryParsingMatchesClaudeCode,
} from './integrations.claude-shared-grant.cases';

export function pooledSequentialTestsPart1() {
  return [
    {
      name: 'rotation -- user rate-limited falls back to pool',
      fn: testRotation_userRateLimitedFallsBackToPool,
    },
    { name: 'rotation -- pool rotates on rate-limit', fn: testRotation_poolRotatesOnRateLimit },
    {
      name: 'rotation -- pool auth_error disables token',
      fn: testRotation_poolAuthErrorDisablesToken,
    },
    {
      name: 'rotation -- user auth_error disables token',
      fn: testRotation_userAuthErrorDisablesToken,
    },
    {
      name: 'rotation -- direct auth_error falls back to pool for Claude Code',
      fn: testRotation_directAuthErrorFallsBackToPoolForClaudeCode,
    },
    {
      name: 'rotation -- near-expiry Claude Code token is not served',
      fn: testRotation_nearExpiryClaudeCodeTokenIsNotServed,
    },
    {
      name: 'claude-code sandbox -- never spends a shared refresh grant',
      fn: testClaudeCodeSandbox_neverSpendsSharedRefreshGrant,
    },
    {
      name: 'claude-code sandbox -- concurrent sessions share one access token',
      fn: testClaudeCodeSandbox_concurrentSessionsShareOneAccessToken,
    },
    {
      name: 'claude-code sandbox -- expiry parsing matches Claude Code',
      fn: testClaudeCodeSandbox_expiryParsingMatchesClaudeCode,
    },
    {
      name: 'rotation -- rate-limit window never shortens',
      fn: testRotation_rateLimitWindowIsMonotonic,
    },
    {
      name: 'rotation -- GPT user auth_error disables token',
      fn: testRotation_gptUserAuthErrorDisablesToken,
    },
    {
      name: 'GPT upload -- clears expired/cooldown state',
      fn: testGptCodeUpload_clearsExpiredAndRateLimitState,
    },
    {
      name: 'rotation -- compute pool rotates across providers',
      fn: testComputeRotation_poolRotatesAcrossProviders,
    },
    {
      name: 'compute token lineage semaphore -- caps live GPT leases',
      fn: testComputeTokenLineageSemaphore_capsLiveGptLeases,
    },
    {
      name: 'compute token demo-cache affinity -- pins provider family',
      fn: testComputeTokenFastCacheAffinity_pinsProviderFamily,
    },
    {
      name: 'compute token provider constraint -- overrides Claude affinity',
      fn: testComputeTokenProviderConstraint_overridesClaudeAffinity,
    },
    {
      name: 'rotation -- auto-expires after cooldown (time-windowed)',
      fn: testRotation_autoExpiresAfterCooldown,
    },
    { name: 'rotation -- all exhausted returns 404', fn: testRotation_allExhausted404 },
    {
      name: 'rotation -- default cooldown is bounded (not permanent)',
      fn: testRotation_defaultCooldownIsBounded,
    },
    {
      name: 'claude-code upload -- clears stale rate-limit cooldown',
      fn: testClaudeCodeUpload_clearsRateLimitCooldown,
    },
    {
      name: 'account pooling default -- synced Claude token inherits enabled',
      fn: testAccountPoolDefault_claudeSyncInheritsEnabled,
    },
    {
      name: 'account pooling default -- synced GPT token inherits enabled',
      fn: testAccountPoolDefault_gptSyncInheritsEnabled,
    },
    {
      name: 'account pooling default -- OFF keeps synced token unpooled',
      fn: testAccountPoolDefault_syncStaysUnpooledWhenDefaultOff,
    },
    {
      name: 'account pooling default -- explicit per-integration override wins',
      fn: testAccountPoolDefault_explicitOverrideWins,
    },
    {
      name: 'account pooling default -- re-sync keeps an already-pooled token',
      fn: testAccountPoolDefault_resyncKeepsPooledToken,
    },
    {
      name: 'claude-code exhaustion -- pool token marked rate-limited at parsed reset time',
      fn: testClaudeCodeExhaustion_marksPoolToken,
    },
    {
      name: 'claude-code exhaustion -- user token marked rate-limited (12h format)',
      fn: testClaudeCodeExhaustion_marksUserToken,
    },
    {
      name: 'claude-code exhaustion -- benign output is no-op',
      fn: testClaudeCodeExhaustion_noBannerNoOp,
    },
    {
      name: 'claude-code auth-failure -- pool token marked rate-limited with long cooldown',
      fn: testClaudeCodeAuthFailure_marksPoolTokenLongCooldown,
    },
    {
      name: 'claude-code auth-failure -- revoked user OAuth is permanently excluded',
      fn: testClaudeCodeRevokedOauth_disablesUserTokenPermanently,
    },
    {
      name: 'claude-code billing-failure -- pool token marked rate-limited with long cooldown',
      fn: testClaudeCodeBillingFailure_marksPoolTokenLongCooldown,
    },
    {
      name: 'claude-code billing-failure -- shared Anthropic key enters cooldown',
      fn: testClaudeCodeBillingFailure_marksSharedAnthropicCooldown,
    },
  ];
}

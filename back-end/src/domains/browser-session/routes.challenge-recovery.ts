import { type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { type AuthRequest, authenticate } from '../../providers/auth';
import { BrowserProviderRateLimitError } from '../../providers/browser';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import {
  getChallengeSolverTelemetry,
  probeBrowserCookieVariant,
  recoverBrowserChallenge,
} from './service.challenge-recovery';
import { ChallengeConfigSearchExhaustedError } from '../../providers/browser/challengeRecovery';
import { SessionNotFoundError } from './service.local-storage';
import { probeCookieVariantSchema, recoverChallengeSchema } from './types';

const log = createLogger('BrowserChallengeRecovery');

async function handleCaptchaTelemetry(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await getChallengeSolverTelemetry(
      String(req.params.taskId),
      req.isInternal === true ? undefined : req.user?.id
    );
    res.json(result);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      res.status(404).json({ error: 'Browser task not found' });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}

async function handleProbeCookieVariant(req: AuthRequest, res: Response): Promise<void> {
  try {
    const input = probeCookieVariantSchema.parse(req.body);
    const result = await probeBrowserCookieVariant({
      taskId: input.task_id,
      userId: req.isInternal === true ? undefined : req.user?.id,
      currentUrl: input.current_url,
      storageState: input.storage_state,
      userAgent: input.user_agent,
      blockedResourceUrl: input.blocked_resource_url,
      recoveryReason: input.recovery_reason,
      blockedConfigKeys: input.blocked_config_keys,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Invalid probe-cookie-variant request', issues: error.issues });
      return;
    }
    if (error instanceof SessionNotFoundError) {
      res.status(404).json({ error: 'Browser task not found' });
      return;
    }
    if (error instanceof BrowserProviderRateLimitError) {
      res.status(429).json({ error: 'browser_provider_rate_limit', provider: error.provider });
      return;
    }
    log.error('Ephemeral cookie-variant probe failed', { error: String(error) });
    res.status(503).json({
      error: 'browser_cookie_variant_probe_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRecoverChallenge(req: AuthRequest, res: Response): Promise<void> {
  const caller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) caller.abort();
  };
  res.once('close', onClose);
  if (res.destroyed && !res.writableFinished) caller.abort();
  try {
    caller.signal.throwIfAborted();
    const input = recoverChallengeSchema.parse(req.body);
    const result = await recoverBrowserChallenge({
      signal: caller.signal,
      taskId: input.task_id,
      userId: req.isInternal === true ? undefined : req.user?.id,
      currentUrl: input.current_url,
      storageState: input.storage_state,
      storageLanes: input.storage_lanes?.map((lane) => ({
        key: lane.key,
        storageState: lane.storage_state,
      })),
      userAgent: input.user_agent,
      blockedResourceUrl: input.blocked_resource_url,
      recoveryReason: input.recovery_reason,
      requirePaymentCdn: input.require_payment_cdn,
      preserveAuth: input.preserve_auth,
      blockedConfigKeys: input.blocked_config_keys,
    });
    if (caller.signal.aborted) return;
    res.json({ success: true, ...result });
  } catch (error) {
    if (caller.signal.aborted) return;
    if (error instanceof ZodError) {
      res.status(400).json({ error: 'Invalid recover-challenge request', issues: error.issues });
      return;
    }
    if (error instanceof SessionNotFoundError) {
      res.status(404).json({ error: 'Browser task not found' });
      return;
    }
    if (error instanceof BrowserProviderRateLimitError) {
      res.status(429).json({ error: 'browser_provider_rate_limit', provider: error.provider });
      return;
    }
    log.error('Browser challenge recovery failed', { error: String(error) });
    const failedConfigKeys =
      error instanceof ChallengeConfigSearchExhaustedError ? error.failedConfigKeys : undefined;
    res.status(503).json({
      error: 'browser_challenge_recovery_failed',
      message: error instanceof Error ? error.message : String(error),
      ...(failedConfigKeys && failedConfigKeys.length > 0
        ? { failed_config_keys: failedConfigKeys }
        : {}),
    });
  } finally {
    res.off('close', onClose);
  }
}

export function registerBrowserChallengeRecoveryRoutes(router: Router): void {
  router.get('/:taskId/captcha-telemetry', authenticate, asyncHandler(handleCaptchaTelemetry));
  router.post('/probe-cookie-variant', authenticate, asyncHandler(handleProbeCookieVariant));
  router.post('/recover-challenge', authenticate, asyncHandler(handleRecoverChallenge));
}

/**
 * One-time CLI sign-in for "Set up with your coding agent" (boxes.dev's
 * `dvb agent-init --login-code` flow, for Rose Projects).
 *
 *   Rose app (signed-in user, project settings)
 *     POST /api/projects/cli-login-codes { projectId? }
 *       ─► mintCliLoginCode: owned project check, sha256(code) stored, +30 min
 *       ◄─ { code, expiresAt, project }
 *   user pastes the prompt into their coding agent
 *     rose agent-init --login-code <code>
 *       POST /api/projects/cli-login-codes/exchange { code }   (no auth, rate-limited)
 *       ─► exchangeCliLoginCode: one conditional UPDATE burns the code and,
 *          if still unexpired, stores sha256(credential), +30 days
 *       ◄─ { credential, expiresAt, project, scope: "projects" }
 *   rose push / onboard: Authorization: Bearer rose_cli_…
 *       ─► verifyCliCredential (projects router only): /api/projects/* and,
 *          when bound, only that project
 *
 * Threat model: a code is 192 random bits, single-use (the first presentation
 * burns it whatever the outcome, so an expired code cannot be retried),
 * stored only as SHA-256 and compared in constant time after the indexed
 * lookup. The credential is 256 random bits, also hashed at rest, accepted by
 * no router other than /api/projects, and cannot mint codes or delete
 * projects. Failed exchanges are rate-limited per client address. The global
 * address-spraying threshold emits one structured warning per window; it does
 * not deny unrelated clients. The bounded overflow bucket retains its shared
 * per-client failure quota. Codes and credentials travel only in POST bodies / headers.
 *
 * 10k-agent behaviour: minting is a user action (one indexed delete of the
 * user's dead rows + one insert); exchange is one conditional update; each
 * CLI-authenticated request is one unique-index read. Limiter memory is
 * bounded by CLI_EXCHANGE_RATE_MAX_KEYS. Nothing is polled or broadcast.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from '../../providers/crypto';
import { createLogger } from '../../providers/logger';
import {
  CLI_CREDENTIAL_TTL_MS,
  CLI_EXCHANGE_GLOBAL_RATE_LIMIT,
  CLI_EXCHANGE_RATE_LIMIT,
  CLI_EXCHANGE_RATE_MAX_KEYS,
  CLI_EXCHANGE_RATE_WINDOW_MS,
  CLI_LOGIN_CODE_TTL_MS,
} from './config';
import * as repo from './repo';
import * as cliRepo from './repoCliLogin';
import { ProjectError, requireProject } from './service';

const log = createLogger('ProjectCliLogin');

export const CLI_LOGIN_CODE_PREFIX = 'rlc_';
export const CLI_CREDENTIAL_PREFIX = 'rose_cli_';
const CODE_PATTERN = /^rlc_[A-Za-z0-9_-]{32}$/;
const CREDENTIAL_PATTERN = /^rose_cli_[A-Za-z0-9_-]{43}$/;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface CliProjectRef {
  id: string;
  name: string;
}

export interface MintedCliLoginCode {
  code: string;
  expiresAt: string;
  project: CliProjectRef | null;
}

export async function mintCliLoginCode(
  userId: string,
  projectId: string | undefined
): Promise<MintedCliLoginCode> {
  const project = projectId !== undefined ? await requireProject(userId, projectId) : null;
  const now = new Date();
  await cliRepo.deleteDeadCliLogins(userId, now);
  const code = `${CLI_LOGIN_CODE_PREFIX}${randomBytes(24).toString('base64url')}`;
  const codeExpiresAt = new Date(now.getTime() + CLI_LOGIN_CODE_TTL_MS);
  const id = randomUUID();
  await cliRepo.insertCliLoginCode({
    id,
    userId,
    projectId: project?.id ?? null,
    codeHash: sha256(code),
    codeExpiresAt,
  });
  log.info('Minted CLI login code', { userId, loginId: id, projectId: project?.id ?? null });
  return {
    code,
    expiresAt: codeExpiresAt.toISOString(),
    project: project ? { id: project.id, name: project.name } : null,
  };
}

export interface ExchangedCliLogin {
  credential: string;
  expiresAt: string;
  userId: string;
  project: CliProjectRef | null;
  scope: 'projects';
}

const INVALID_CODE =
  'This login code is invalid, expired or already used. Copy a fresh prompt from Rose.';

export async function exchangeCliLoginCode(code: string): Promise<ExchangedCliLogin> {
  if (!CODE_PATTERN.test(code)) throw new ProjectError(401, INVALID_CODE, 'cli_code_invalid');
  const codeHash = sha256(code);
  const credential = `${CLI_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
  const now = new Date();
  const credentialExpiresAt = new Date(now.getTime() + CLI_CREDENTIAL_TTL_MS);
  const row = await cliRepo.burnCliLoginCode({
    codeHash,
    credentialHash: sha256(credential),
    credentialExpiresAt,
    now,
  });
  if (row === null || !sameHash(row.codeHash, codeHash) || !row.issued) {
    log.warn('Rejected CLI login code', { loginId: row?.id ?? null, burned: row !== null });
    throw new ProjectError(401, INVALID_CODE, 'cli_code_invalid');
  }
  const project = row.projectId !== null ? await repo.findProject(row.userId, row.projectId) : null;
  log.info('Exchanged CLI login code', {
    userId: row.userId,
    loginId: row.id,
    projectId: row.projectId,
  });
  return {
    credential,
    expiresAt: credentialExpiresAt.toISOString(),
    userId: row.userId,
    project: project ? { id: project.id, name: project.name } : null,
    scope: 'projects',
  };
}

export function isCliCredential(token: string): boolean {
  return token.startsWith(CLI_CREDENTIAL_PREFIX);
}

export interface CliCredentialScope {
  userId: string;
  /** Bound project; null = any of the user's projects. */
  projectId: string | null;
}

/** null = unknown, malformed or expired credential. */
export async function verifyCliCredential(token: string): Promise<CliCredentialScope | null> {
  if (!CREDENTIAL_PATTERN.test(token)) return null;
  const hash = sha256(token);
  const row = await cliRepo.findLiveCliCredential(hash, new Date());
  if (row === null || !sameHash(row.credentialHash, hash)) return null;
  return { userId: row.userId, projectId: row.projectId };
}

/**
 * Fixed-window FAILED-attempt counter: `limit` failures per key block that key
 * until the window ends. `globalLimit` failures trigger one address-spraying
 * warning per window, never process-wide denial. Only failures count, so a
 * legitimate exchange never spends the quota; a shared client address shares
 * the failed-attempt quota.
 * Memory is bounded: once `maxKeys` addresses are tracked in a window, further
 * unseen addresses share one overflow bucket.
 */
export class ExchangeRateLimiter {
  private windowStart = 0;
  private total = 0;
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly limit = CLI_EXCHANGE_RATE_LIMIT,
    private readonly windowMs = CLI_EXCHANGE_RATE_WINDOW_MS,
    private readonly globalLimit = CLI_EXCHANGE_GLOBAL_RATE_LIMIT,
    private readonly maxKeys = CLI_EXCHANGE_RATE_MAX_KEYS
  ) {}

  private roll(now: number): void {
    if (now - this.windowStart < this.windowMs) return;
    this.windowStart = now;
    this.total = 0;
    this.failures.clear();
  }

  private bucket(rawKey: string): string {
    return this.failures.has(rawKey) || this.failures.size < this.maxKeys ? rawKey : '\0overflow';
  }

  /** Check before looking the code up; seconds to wait when the address is blocked. */
  check(
    rawKey: string,
    now = Date.now()
  ): { allowed: true } | { allowed: false; retryAfterS: number } {
    this.roll(now);
    const count = this.failures.get(this.bucket(rawKey)) ?? 0;
    if (count < this.limit) return { allowed: true };
    const retryAfterS = Math.max(1, Math.ceil((this.windowStart + this.windowMs - now) / 1000));
    return { allowed: false, retryAfterS };
  }

  /** Record a rejected attempt (bad body, unknown, malformed, used or expired code). */
  recordFailure(rawKey: string, now = Date.now()): void {
    this.roll(now);
    const key = this.bucket(rawKey);
    this.failures.set(key, (this.failures.get(key) ?? 0) + 1);
    this.total += 1;
    if (this.total === this.globalLimit) {
      log.warn('CLI exchange address-spraying threshold reached', {
        failures: this.total,
        threshold: this.globalLimit,
        trackedAddressBuckets: this.failures.size,
        windowMs: this.windowMs,
      });
    }
  }
}

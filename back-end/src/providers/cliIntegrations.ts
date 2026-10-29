/**
 * CLI connections publish installs into per-user filesystem templates and keep
 * encrypted credentials separate, leased only while native commands execute.
 * Legacy proxied commands retain their durable caller-scoped execution receipts;
 * ambiguous transport failures are never retried implicitly.
 */
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { prisma, runTransactionWithRetry } from './database';
import { basename } from 'node:path';
import { createLogger } from './logger';
import { executeTemplateCli, readTemplateCredentials, type CliResult } from './cliTemplate';
import { availableSizes, sandboxTemplateFor, sizeKey } from './codeSessions/sandboxSize';
import {
  publishUserCodeTemplate,
  UserCodeTemplateError,
  type PublicationFence,
} from './userCodeTemplates';
import { buildNativeCliTemplate } from './nativeCliTemplateBuilder';
import { initializeCliCredentials } from './cliNativeCredentials';
import { withCliPublicationLease, type CliPublicationAuth } from './cliPublicationLease';

const log = createLogger('CliIntegrations');

export class CliIntegrationError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface CliConfig {
  kind: 'cli-template-v1';
  request: string;
  name: string;
  agent_id: string;
  command?: string;
  code_session_id?: string;
  verify?: string[];
  native_template?: boolean;
  credential_files?: string[];
  template_revision?: number;
}

type IntegrationRow = {
  id: string;
  userId: string;
  status: string;
  config: Prisma.JsonValue;
  failureReason: string | null;
};
export type LaunchCliSetup = (params: {
  userId: string;
  agentId: string;
  goal: string;
}) => Promise<void>;
export interface CliCaller {
  userId: string;
  agentId: string;
  taskId: string | null;
}

export function cliStableId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function cliConfig(raw: Prisma.JsonValue): CliConfig | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (
    raw.kind !== 'cli-template-v1' ||
    typeof raw.request !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.agent_id !== 'string'
  )
    return null;
  return raw as unknown as CliConfig;
}

export function cliView(row: IntegrationRow) {
  const config = cliConfig(row.config);
  if (config === null) throw new CliIntegrationError(404, 'CLI connection not found');
  return {
    id: row.id,
    name: config.name,
    request: config.request,
    agent_id: config.agent_id,
    status:
      row.status === 'CONNECTED' ? 'connected' : row.status === 'SYNCING' ? 'setting_up' : 'failed',
    error: row.failureReason,
  };
}

function uniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function ownedIntegration(userId: string, id: string) {
  const row = await prisma.integration.findFirst({
    where: { id, userId, name: 'cli', type: 'TOOL_SETUP' },
  });
  if (row === null || cliConfig(row.config) === null)
    throw new CliIntegrationError(404, 'CLI connection not found');
  return row;
}

export async function listCliIntegrations(userId: string) {
  const rows = await prisma.integration.findMany({
    where: { userId, name: 'cli', type: 'TOOL_SETUP' },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  const connections = rows.filter((row) => cliConfig(row.config) !== null);
  // One bounded indexed batch: a retired/missing template is never advertised as connected.
  const ids = connections
    .map((row) => cliConfig(row.config)?.code_session_id)
    .filter((id): id is string => typeof id === 'string');
  const sessions = ids.length
    ? await prisma.codeSession.findMany({
        where: {
          userId,
          id: { in: ids },
          state: { not: 'RETIRED' },
          sandboxKind: 'e2b',
          sandboxId: { not: null },
        },
        select: { id: true },
      })
    : [];
  const available = new Set(sessions.map((session) => session.id));
  const setupIds = connections
    .filter((row) => row.status === 'SYNCING')
    .map((row) => cliConfig(row.config)!.agent_id);
  const setupAgents = setupIds.length
    ? await prisma.agent.findMany({
        where: { userId, id: { in: setupIds } },
        select: { id: true, status: true, deletedAt: true },
      })
    : [];
  const setupById = new Map(setupAgents.map((agent) => [agent.id, agent]));
  return {
    integrations: connections.map((row) => {
      const view = cliView(row);
      if (view.status === 'setting_up') {
        const agent = setupById.get(view.agent_id);
        if (
          (!agent && Date.now() - row.createdAt.getTime() > 60_000) ||
          agent?.deletedAt ||
          agent?.status === 'FAILED' ||
          agent?.status === 'COMPLETED'
        ) {
          return {
            ...view,
            status: 'failed',
            error:
              'Setup ended without a verified connection. Open the setup agent for details or add this CLI again.',
          };
        }
      }
      if (
        view.status === 'connected' &&
        !cliConfig(row.config)?.native_template &&
        !available.has(cliConfig(row.config)?.code_session_id ?? '')
      ) {
        return {
          ...view,
          status: 'failed',
          error: 'Template unavailable. Connect this CLI again to restore access.',
        };
      }
      return view;
    }),
  };
}

export function cliSetupGoal(integrationId: string, request: string): string {
  return `Connect the CLI requested by the user: ${request}\nIntegration ID: ${integrationId}.\nYou are a normal Rose agent coordinating this setup. Spawn a cloud code agent in the background to discover the official CLI, install it, authenticate it, and verify the connected account. Its immediate parent is you: handle its rose-agents send parent browser requests with your existing browser spawn_agent tool and normal credential protocol, then send back the outcome. Do not ask for credentials already available in the browser. Prefer device-code login when the CLI supports it. Keep the login subprocess and the code-agent turn alive while the parent handles authorization; do not terminate the login with a short timeout or close its input prematurely.\nThe code agent publishes with: rose cli publish ${integrationId} --name <display-name> --command <absolute-real-executable-path> --verify '<JSON argv for harmless authenticated identity check>' --install-script '<repeatable official installation shell script>' --install-verify '<JSON argv for an UNAUTHENTICATED version check>' --credential-files '<JSON array of credential file paths relative to /home/user, e.g. [".yc/credentials.json"]>'. For a public CLI use []. Discover the actual CLI credential paths; only file-based logins are supported. Never point command at a Rose wrapper. The install script must install without login, secrets, user content or agent runtime configuration; it is replayed into clean Claude and Codex base environments. Install under /home/user/.local/bin or the CLI's standard directory.\nPublication builds immutable filesystem snapshots and atomically switches the user's template revision after every provider/size build succeeds. Other CLI installs are preserved. If another publisher is busy, retry publication after it finishes; never snapshot or replace the shared template yourself. Credentials are stored separately encrypted and leased to native CLI commands; never put them in the install script, snapshots, messages or ordinary integration config. If a stale credential lease needs reconnection, establish a fresh login rather than copying the potentially rotated old token. Do not finish until publication succeeds, or report the actual blocker. Preserve Freedom and all user protections.`;
}

export async function createCliIntegration(
  userId: string,
  request: string,
  requestId: string,
  launch: LaunchCliSetup
) {
  const id = cliStableId(`cli:${userId}:${requestId}`);
  const agentId = cliStableId(`cli-agent:${userId}:${requestId}`);
  const config: CliConfig = { kind: 'cli-template-v1', request, name: request, agent_id: agentId };
  let row;
  try {
    row = await prisma.integration.create({
      data: {
        id,
        userId,
        name: 'cli',
        accountId: requestId,
        type: 'TOOL_SETUP',
        status: 'SYNCING',
        isActive: false,
        config: { ...config },
      },
    });
  } catch (error) {
    if (!uniqueConflict(error)) throw error;
    const existing = await ownedIntegration(userId, id);
    if (cliConfig(existing.config)?.request !== request)
      throw new CliIntegrationError(409, 'request_id was already used for a different CLI');
    // Recover a process crash between storing the connection and starting its agent.
    if (existing.status === 'SYNCING' && Date.now() - existing.updatedAt.getTime() > 60_000) {
      const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { id: true } });
      if (agent === null) {
        const claimed = await prisma.integration.updateMany({
          where: { id, updatedAt: existing.updatedAt },
          data: { updatedAt: new Date() },
        });
        if (claimed.count === 1) await launch({ userId, agentId, goal: cliSetupGoal(id, request) });
      }
    }
    return cliView(existing);
  }
  try {
    await launch({ userId, agentId, goal: cliSetupGoal(id, request) });
  } catch {
    row = await prisma.integration.update({
      where: { id },
      data: {
        status: 'SYNC_FAILED',
        failureReason: 'Setup could not start. Add the CLI again to retry.',
      },
    });
  }
  return cliView(row);
}

export interface CliPublishBody {
  name: string;
  command: string;
  verify: string[];
  install?: string;
  install_verify?: string[];
  credential_files?: string[];
}

/** Fence verification/capture too: two publishers must never race rotating login tokens. */
export async function publishCliIntegration(caller: CliCaller, id: string, body: CliPublishBody) {
  const row = await ownedIntegration(caller.userId, id);
  const config = cliConfig(row.config)!;
  if (config.agent_id !== caller.agentId || caller.taskId === null)
    throw new CliIntegrationError(403, 'Only this connection’s setup code agent can publish it');
  if (row.status === 'CONNECTED' && config.native_template) return { integration: cliView(row) };
  return withCliPublicationLease(caller.userId, id, async (token, assertOwned, auth) =>
    publishClaimedCliIntegration(caller, id, body, { integrationId: id, token }, assertOwned, auth)
  );
}

async function publishClaimedCliIntegration(
  caller: CliCaller,
  id: string,
  body: CliPublishBody,
  fence?: PublicationFence,
  assertOwned?: () => Promise<void>,
  auth?: CliPublicationAuth
) {
  const row = await ownedIntegration(caller.userId, id);
  const config = cliConfig(row.config)!;
  if (row.status === 'CONNECTED' && config.native_template && config.agent_id === caller.agentId)
    return { integration: cliView(row) };
  if (caller.taskId === null || config.agent_id !== caller.agentId)
    throw new CliIntegrationError(403, 'Only this connection’s setup code agent can publish it');
  const task = await prisma.claudeCodeSession.findUnique({ where: { id: caller.taskId } });
  if (
    task === null ||
    task.agentId !== caller.agentId ||
    task.status === 'CLOSED' ||
    task.codeSessionId === null
  )
    throw new CliIntegrationError(409, 'The setup code session is no longer active');
  const session = await prisma.codeSession.findUnique({ where: { id: task.codeSessionId } });
  if (
    session === null ||
    session.userId !== caller.userId ||
    session.state === 'RETIRED' ||
    session.sandboxKind !== 'e2b' ||
    session.sandboxId === null
  )
    throw new CliIntegrationError(409, 'CLI connections require a persistent cloud template');
  if (body.install !== undefined && (!body.install_verify || !body.credential_files))
    throw new CliIntegrationError(
      400,
      'Installation verification and credential paths are required'
    );
  await auth?.beginAuth();
  await assertOwned?.();
  const result = await executeTemplateCli({
    sandboxId: session.sandboxId,
    command: body.command,
    args: body.verify,
    conversation: caller.taskId,
    pauseAfter: false,
  });
  if (result.exit_code !== 0) {
    await auth?.endAuth();
    throw new CliIntegrationError(
      422,
      'The authenticated verification command failed; finish login before publishing'
    );
  }
  let templateRevision: number | undefined;
  if (body.install !== undefined) {
    // Capture login separately before publishing. No authenticated sandbox is ever snapshotted.
    await assertOwned?.();
    const credentials = await readTemplateCredentials(session.sandboxId, body.credential_files!);
    await initializeCliCredentials(caller.userId, id, credentials, fence?.token);
    await auth?.endAuth();
    await assertOwned?.();
    const variants = (['claude', 'codex'] as const).flatMap((provider) =>
      availableSizes(provider).map((size) => ({
        key: `${provider}-${sizeKey(size)}`,
        provider,
        ...size,
        baseTemplateId: sandboxTemplateFor(provider, size)!,
      }))
    );
    try {
      const head = await publishUserCodeTemplate(
        caller.userId,
        id,
        {
          id: cliStableId(`native-command:${basename(body.command)}`),
          connectionId: id,
          name: body.name,
          command: body.command,
          install: body.install,
          verify: body.install_verify!,
        },
        variants,
        buildNativeCliTemplate,
        undefined,
        fence
      );
      templateRevision = head.revision;
    } catch (error) {
      if (error instanceof UserCodeTemplateError) {
        if (error.orphanSnapshots.length)
          log.warn('Template publication left unpublished snapshots', {
            userId: caller.userId,
            integrationId: id,
            snapshotIds: error.orphanSnapshots,
          });
        throw new CliIntegrationError(error.status, error.message);
      }
      throw error;
    }
  }
  if (body.install === undefined) await auth?.endAuth();
  const committedConfig = { ...config } as CliConfig & {
    publishing_token?: string;
    publishing_expires_at?: number;
    publishing_auth_inflight?: boolean;
  };
  delete committedConfig.publishing_token;
  delete committedConfig.publishing_expires_at;
  delete committedConfig.publishing_auth_inflight;
  const update = (db: Pick<Prisma.TransactionClient, 'integration'>) =>
    db.integration.update({
      where: { id },
      data: {
        status: 'CONNECTED',
        isActive: true,
        failureReason: null,
        config: {
          ...committedConfig,
          name: body.name,
          command: body.command,
          ...(templateRevision === undefined
            ? { code_session_id: session.id }
            : {
                native_template: true,
                credential_files: body.credential_files!,
                template_revision: templateRevision,
              }),
          verify: body.verify,
        },
      },
    });
  // Reconnecting a CLI replaces its old credential authority and wrapper together.
  const prior =
    templateRevision === undefined
      ? []
      : await prisma.integration.findMany({
          where: { userId: caller.userId, name: 'cli', status: 'CONNECTED', id: { not: id } },
          select: { id: true, config: true },
          take: 200,
        });
  const replaced = prior
    .filter((row) => {
      const priorConfig = cliConfig(row.config);
      return (
        priorConfig?.native_template &&
        priorConfig.command &&
        basename(priorConfig.command) === basename(body.command)
      );
    })
    .map((row) => row.id);
  const updated = await runTransactionWithRetry(async (tx) => {
    if (fence) {
      const owned = await tx.integration.updateMany({
        where: {
          id,
          userId: caller.userId,
          AND: [
            { config: { path: ['publishing_token'], equals: fence.token } },
            { config: { path: ['publishing_expires_at'], gt: Date.now() } },
          ],
        },
        data: { updatedAt: new Date() },
      });
      if (owned.count !== 1)
        throw new CliIntegrationError(409, 'CLI publication lease expired or was replaced');
    }
    if (templateRevision === undefined) return update(tx);
    // Serialize this final login promotion against snapshot pointer writes. A newer
    // setup of the same CLI must not be displaced by an older publisher finishing late.
    await tx.integration.updateMany({
      where: { userId: caller.userId, name: 'code_template', accountId: '' },
      data: { updatedAt: new Date() },
    });
    const head = await tx.integration.findUnique({
      where: {
        userId_name_accountId: {
          userId: caller.userId,
          name: 'code_template',
          accountId: '',
        },
      },
      select: { config: true },
    });
    const manifest = head?.config as unknown as
      { recipes?: Array<{ id: string; connectionId?: string }> } | undefined;
    const activeRecipe = manifest?.recipes?.find(
      (recipe) => recipe.id === cliStableId(`native-command:${basename(body.command)}`)
    );
    if (activeRecipe?.connectionId !== id)
      throw new CliIntegrationError(
        409,
        'A newer setup of this CLI was published; use that connection'
      );
    if (replaced.length)
      await tx.integration.updateMany({
        where: { id: { in: replaced }, userId: caller.userId },
        data: {
          status: 'EXPIRED',
          isActive: false,
          failureReason: 'Replaced by a new CLI connection.',
        },
      });
    return update(tx);
  });
  return { integration: cliView(updated), verification: result };
}

/** Request receipts survive API retries; uncertain calls stay uncertain rather than execute twice. */
export async function runCliIntegration(
  caller: CliCaller,
  id: string,
  args: string[],
  requestId: string
): Promise<CliResult> {
  const row = await ownedIntegration(caller.userId, id);
  const config = cliConfig(row.config)!;
  if (config.native_template)
    throw new CliIntegrationError(
      409,
      'Use the installed native CLI or rose cli native for this connection'
    );
  if (row.status !== 'CONNECTED' || !config.code_session_id || !config.command)
    throw new CliIntegrationError(409, 'CLI is not connected');
  if (caller.taskId === null) throw new CliIntegrationError(403, 'A code session is required');
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: caller.taskId },
    select: { agentId: true, status: true },
  });
  if (task === null || task.agentId !== caller.agentId || task.status === 'CLOSED')
    throw new CliIntegrationError(403, 'Code session is no longer active');
  const receiptId = cliStableId(
    `cli-run:${caller.userId}:${caller.agentId}:${caller.taskId}:${requestId}`
  );
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([id, args]))
    .digest('hex');
  const previous = await prisma.message.findUnique({ where: { id: receiptId } });
  if (previous !== null) return readReceipt(previous.metadata, fingerprint);
  // Lease before claiming: a busy template is retryable because nothing ran.
  const lease = `cli:${receiptId}`;
  const now = new Date();
  const acquired = await prisma.codeSession.updateMany({
    where: {
      id: config.code_session_id,
      userId: caller.userId,
      state: { not: 'RETIRED' },
      sandboxKind: 'e2b',
      sandboxId: { not: null },
      OR: [{ leaseOwner: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      leaseOwner: lease,
      leaseExpiresAt: new Date(now.getTime() + 120_000),
      lastActiveAt: now,
    },
  });
  if (acquired.count !== 1)
    throw new CliIntegrationError(
      409,
      'CLI template is busy or unavailable; retry when setup or the current command finishes'
    );
  try {
    const session = await prisma.codeSession.findUnique({ where: { id: config.code_session_id } });
    if (session?.sandboxId === null || session === null)
      throw new CliIntegrationError(409, 'CLI template is unavailable; reconnect it');
    try {
      await prisma.message.create({
        data: {
          id: receiptId,
          agentId: caller.agentId,
          role: 'TOOL',
          text: '',
          metadata: { excludeFromModel: true, cliRun: { fingerprint, status: 'running' } },
        },
      });
    } catch (error) {
      if (!uniqueConflict(error)) throw error;
      const existing = await prisma.message.findUniqueOrThrow({ where: { id: receiptId } });
      return readReceipt(existing.metadata, fingerprint);
    }
    let result: CliResult;
    try {
      result = await executeTemplateCli({
        sandboxId: session.sandboxId,
        command: config.command,
        args,
        conversation: caller.taskId,
        pauseAfter: true,
      });
    } catch {
      await prisma.message.update({
        where: { id: receiptId },
        data: {
          metadata: { excludeFromModel: true, cliRun: { fingerprint, status: 'uncertain' } },
        },
      });
      throw new CliIntegrationError(
        503,
        'CLI transport failed. Execution outcome is unknown; this request will not be repeated automatically.'
      );
    }
    await prisma.message.update({
      where: { id: receiptId },
      data: {
        metadata: {
          excludeFromModel: true,
          cliRun: { fingerprint, status: 'completed', result: { ...result } },
        },
      },
    });
    return result;
  } finally {
    await prisma.codeSession.updateMany({
      where: { id: config.code_session_id, leaseOwner: lease },
      data: { leaseOwner: null, leaseExpiresAt: null, lastActiveAt: new Date() },
    });
  }
}

export function readReceipt(metadata: Prisma.JsonValue, fingerprint: string): CliResult {
  const receipt =
    metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
      ? metadata.cliRun
      : null;
  if (
    receipt === null ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.fingerprint !== fingerprint
  )
    throw new CliIntegrationError(409, 'request_id was already used for a different command');
  const result = receipt.result;
  if (
    receipt.status !== 'completed' ||
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    typeof result.exit_code !== 'number' ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string'
  )
    throw new CliIntegrationError(
      409,
      'This request is running or its outcome is unknown; it will not be executed again'
    );
  return { exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr };
}

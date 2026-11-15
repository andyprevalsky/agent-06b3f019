/**
 * A teammate's `rose cli run` on a team-shared native-template CLI, executed
 * entirely on the OWNER's side (docs/plans/active/share-all-integrations.md):
 *
 *   start a fresh sandbox from the owner's published CLI template snapshot
 *     └► lease the owner's credential bundle server-side (holder = teammate's task)
 *         └► write the files into THAT sandbox only (no-follow, 0600)
 *             └► claim the receipt, run `command args` there
 *                 └► capture the files the command left, release the lease with them
 *                     (refreshed logins persist), scrub every owner secret
 *                     (old and refreshed) from output and receipt
 *   └► kill the sandbox
 *
 * The teammate's own sandbox never receives a credential file; native
 * acquire / heartbeat / release stay owner-only (cliNativeCredentials.ts).
 * Anything that fails before the command runs releases the original files and
 * is retryable; once it ran, an unknown outcome is never re-run, and output
 * whose refreshed login could not be captured is withheld (fail closed).
 *
 * 10k agents: one sandbox per shared run, bounded by E2B creation pacing.
 */
import { Prisma } from '@prisma/client';
import type { Sandbox } from 'e2b';
import { prisma } from './database';
import { createLogger } from './logger';
import { CliIntegrationError, type CliCaller } from './cliIntegrations';
import { readReceipt } from './cliReceipts';
import {
  acquireOwnerCliLease,
  releaseOwnerCliLease,
  type CliCredentialFile,
} from './cliNativeCredentials';
import { executeTemplateCli, type CliResult } from './cliTemplate';
import { scrubCliResult, secretsOf } from './cliTeamShares';
import { readUserCodeTemplate } from './userCodeTemplates';
import { sandboxTemplateFor } from './codeSessions/sandboxSize';
import { shellQuote } from './codeSessions/sandboxFs';
import { NATIVE_CLI_PATH } from './codeSessions/sandboxPaths';
import { createSandboxWithRetry } from './e2bSandboxCreate';
import { withClaudeCodeCreateSlot } from './e2bCreateSlot';

const log = createLogger('CliSharedNativeRun');

export const OWNER_CLI_ENVIRONMENT_UNAVAILABLE =
  "The owner's CLI environment could not start, so nothing ran. Retry the command later.";
export const OWNER_CLI_TEMPLATE_UNAVAILABLE =
  "The owner's CLI installation is unavailable. Ask the owner to connect this CLI again.";
export const SHARED_CLI_TRANSPORT_FAILED =
  'CLI transport failed. Execution outcome is unknown; this request will not be repeated automatically.';
export const SHARED_CLI_OUTPUT_WITHHELD =
  "The command ran in the owner's environment, but its login could not be saved back, so its output is withheld. Ask the owner to reconnect this CLI.";

/** The owner-side sandbox a shared native CLI runs in (injectable for tests). */
export interface OwnerCliSandbox {
  readonly sandboxId: string;
  writeFiles(files: CliCredentialFile[]): Promise<void>;
  run(command: string, args: string[], conversation: string): Promise<CliResult>;
  /** Current content of each path; null data for a file the command removed. */
  readFiles(paths: string[]): Promise<CliCredentialFile[]>;
  kill(): Promise<void>;
}
export type OwnerCliSandboxFactory = (
  ownerUserId: string,
  integrationId: string
) => Promise<OwnerCliSandbox>;

/** argv: spec file (deleted after reading), home. No-follow walk; files 0600, dirs 0700. */
export const OWNER_CLI_WRITE_SCRIPT = `import os,sys,json,base64
spec_path=sys.argv[1]
home=sys.argv[2]
with open(spec_path) as stream:
    spec=json.load(stream)
os.unlink(spec_path)
for item in spec:
    parts=item['path'].split('/')
    directory=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                os.mkdir(part,0o700,dir_fd=directory)
            except FileExistsError:
                pass
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory)
            directory=child
        if item['data'] is None:
            try:
                os.unlink(parts[-1],dir_fd=directory)
            except FileNotFoundError:
                pass
            continue
        fd=os.open(parts[-1],os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600,dir_fd=directory)
        with os.fdopen(fd,'wb') as stream:
            stream.write(base64.b64decode(item['data']))
            os.fchmod(stream.fileno(),0o600)
    finally:
        os.close(directory)`;

/** argv: JSON paths, home. No-follow capture; a missing file reads as null data. */
export const OWNER_CLI_READ_SCRIPT = `import os,sys,json,stat,base64
files=[]
total=0
home=sys.argv[2]
for path in json.loads(sys.argv[1]):
    parts=path.split('/')
    data=None
    directory=os.open(home,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        try:
            for part in parts[:-1]:
                child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
                os.close(directory)
                directory=child
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        except FileNotFoundError:
            fd=None
        if fd is not None:
            try:
                info=os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size>65536:
                    raise ValueError('unsupported credential file')
                with os.fdopen(fd,'rb',closefd=False) as stream:
                    raw=stream.read(65537)
                total+=len(raw)
                if len(raw)>65536 or total>262144:
                    raise ValueError('credential size exceeded')
                data=base64.b64encode(raw).decode('ascii')
            finally:
                os.close(fd)
    finally:
        os.close(directory)
    files.append({'path':path,'data':data})
print(json.dumps(files))`;

function e2bOwnerSandbox(sandbox: Sandbox): OwnerCliSandbox {
  return {
    sandboxId: sandbox.sandboxId,
    async writeFiles(files) {
      const spec = `/tmp/rose-shared-cli-${sandbox.sandboxId}.json`;
      await sandbox.files.write(spec, new Blob([JSON.stringify(files)]));
      const result = await sandbox.commands.run(
        `python3 -c ${shellQuote(OWNER_CLI_WRITE_SCRIPT)} ${shellQuote(spec)} /home/user`,
        { cwd: '/home/user', timeoutMs: 30_000 }
      );
      if (result.exitCode !== 0) throw new Error('credential write failed');
    },
    run: (command, args, conversation) =>
      executeTemplateCli({
        sandboxId: sandbox.sandboxId,
        command,
        args,
        conversation,
        pauseAfter: false,
      }),
    async readFiles(paths) {
      const result = await sandbox.commands.run(
        `python3 -c ${shellQuote(OWNER_CLI_READ_SCRIPT)} ${shellQuote(JSON.stringify(paths))} /home/user`,
        { cwd: '/home/user', timeoutMs: 30_000 }
      );
      if (result.exitCode !== 0) throw new Error('credential capture failed');
      return JSON.parse(result.stdout) as CliCredentialFile[];
    },
    kill: async () => {
      await sandbox.kill();
    },
  };
}

/** A fresh sandbox from the owner's newest published CLI template on a current base image. */
export async function startOwnerCliSandbox(
  ownerUserId: string,
  integrationId: string
): Promise<OwnerCliSandbox> {
  const head = await readUserCodeTemplate(ownerUserId);
  const variant = (head?.variants ?? [])
    .filter(
      (entry) =>
        entry.snapshotId !== '' &&
        sandboxTemplateFor(entry.provider, { cpu: entry.cpu, memoryGb: entry.memoryGb }) ===
          entry.baseTemplateId
    )
    .sort((a, b) => a.cpu - b.cpu || a.memoryGb - b.memoryGb)[0];
  if (variant === undefined) throw new CliIntegrationError(409, OWNER_CLI_TEMPLATE_UNAVAILABLE);
  const create = () =>
    createSandboxWithRetry(
      variant.snapshotId,
      {
        apiKey: process.env.E2B_API_KEY,
        timeoutMs: 5 * 60_000,
        envs: { HOME: '/home/user', PATH: NATIVE_CLI_PATH, LANG: 'C.UTF-8' },
        metadata: { purpose: 'shared-native-cli', integrationId },
      },
      'Shared native CLI'
    );
  const sandbox = await (variant.provider === 'claude'
    ? withClaudeCodeCreateSlot(create)
    : create());
  return e2bOwnerSandbox(sandbox);
}

type Outcome = 'completed' | 'uncertain';
async function claimReceipt(receiptId: string, agentId: string, fingerprint: string) {
  try {
    await prisma.message.create({
      data: {
        id: receiptId,
        agentId,
        role: 'TOOL',
        text: '',
        metadata: { excludeFromModel: true, cliRun: { fingerprint, status: 'running' } },
      },
    });
    return null;
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error;
    const existing = await prisma.message.findUniqueOrThrow({ where: { id: receiptId } });
    return readReceipt(existing.metadata, fingerprint);
  }
}
async function settleReceipt(
  receiptId: string,
  fingerprint: string,
  status: Outcome,
  result?: CliResult
) {
  await prisma.message.update({
    where: { id: receiptId },
    data: {
      metadata: {
        excludeFromModel: true,
        cliRun: { fingerprint, status, ...(result ? { result: { ...result } } : {}) },
      },
    },
  });
}

export interface SharedNativeRun {
  caller: CliCaller & { taskId: string };
  ownerUserId: string;
  integrationId: string;
  args: string[];
  receiptId: string;
  fingerprint: string;
  /** The owner's stored secrets (cliTeamShares.sharedCliSecrets). */
  secrets: string[];
  start: OwnerCliSandboxFactory;
}

export async function runSharedNativeCli(run: SharedNativeRun): Promise<CliResult> {
  const { caller, ownerUserId, integrationId } = run;
  const holder = { agentId: caller.agentId, taskId: caller.taskId };
  const context = { integrationId, ownerUserId, userId: caller.userId, agentId: caller.agentId };
  let sandbox: OwnerCliSandbox;
  try {
    sandbox = await run.start(ownerUserId, integrationId);
  } catch (error) {
    if (error instanceof CliIntegrationError) throw error;
    log.error('Owner CLI sandbox failed to start', { ...context, error: String(error) });
    throw new CliIntegrationError(503, OWNER_CLI_ENVIRONMENT_UNAVAILABLE);
  }
  try {
    const lease = await acquireOwnerCliLease(ownerUserId, integrationId, holder);
    const release = (files: CliCredentialFile[]) =>
      releaseOwnerCliLease(ownerUserId, integrationId, holder, lease.token, files);
    const captureAndRelease = async (): Promise<CliCredentialFile[] | null> => {
      try {
        const files = await sandbox.readFiles(lease.paths);
        await release(files);
        return files;
      } catch (error) {
        // Never release unknown state: the command may have rotated the login.
        log.error('Owner CLI login capture failed; lease left to expire', {
          ...context,
          sandboxId: sandbox.sandboxId,
          error: String(error),
        });
        return null;
      }
    };
    let claimed: CliResult | null;
    try {
      await sandbox.writeFiles(lease.files);
      // Claimed only once the command can run: every earlier failure is retryable.
      claimed = await claimReceipt(run.receiptId, caller.agentId, run.fingerprint);
    } catch (error) {
      await release(lease.files);
      if (error instanceof CliIntegrationError) throw error;
      log.error('Owner CLI preparation failed', { ...context, error: String(error) });
      throw new CliIntegrationError(503, OWNER_CLI_ENVIRONMENT_UNAVAILABLE);
    }
    if (claimed !== null) {
      await release(lease.files);
      return claimed;
    }
    let raw: CliResult;
    try {
      raw = await sandbox.run(lease.command, run.args, caller.taskId);
    } catch {
      await captureAndRelease();
      await settleReceipt(run.receiptId, run.fingerprint, 'uncertain');
      throw new CliIntegrationError(503, SHARED_CLI_TRANSPORT_FAILED);
    }
    const after = await captureAndRelease();
    if (after === null) {
      await settleReceipt(run.receiptId, run.fingerprint, 'uncertain');
      throw new CliIntegrationError(503, SHARED_CLI_OUTPUT_WITHHELD);
    }
    const refreshed = after.flatMap((file) =>
      file.data === null ? [] : [Buffer.from(file.data, 'base64').toString('utf8')]
    );
    const secrets = [...new Set([...secretsOf(refreshed), ...run.secrets])].sort(
      (a, b) => b.length - a.length
    );
    const result = scrubCliResult(raw, secrets);
    await settleReceipt(run.receiptId, run.fingerprint, 'completed', result);
    log.info('Shared native CLI ran in owner sandbox', {
      ...context,
      sandboxId: sandbox.sandboxId,
      exitCode: result.exit_code,
    });
    return result;
  } finally {
    await sandbox.kill().catch((error: unknown) => {
      log.error('Owner CLI sandbox cleanup failed', {
        ...context,
        sandboxId: sandbox.sandboxId,
        error: String(error),
      });
    });
  }
}

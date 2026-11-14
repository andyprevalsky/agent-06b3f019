/** Executes argv in a user's existing cloud template. Never runs on the API host. */
import { Sandbox } from 'e2b';
import { isCliCredentialPath } from './cliNativeCredentials';
import { shellQuote } from './codeSessions/sandboxFs';

export interface CliResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export function cliCommand(command: string, args: string[], conversation: string): string {
  return `exec env YC_CLI_SESSION=${shellQuote(conversation)} ${[command, ...args].map(shellQuote).join(' ')}`;
}

export async function executeTemplateCli(params: {
  sandboxId: string;
  command: string;
  args: string[];
  conversation: string;
  pauseAfter: boolean;
}): Promise<CliResult> {
  const sandbox = await Sandbox.connect(params.sandboxId, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 60_000,
  });
  try {
    try {
      const result = await sandbox.commands.run(
        cliCommand(params.command, params.args, params.conversation),
        {
          cwd: '/home/user',
          timeoutMs: 30_000,
        }
      );
      return {
        exit_code: result.exitCode,
        stdout: result.stdout.slice(0, 65_536),
        stderr: result.stderr.slice(0, 65_536),
      };
    } catch (error) {
      // The E2B SDK throws for normal nonzero process exits, preserving these fields.
      if (
        error !== null &&
        typeof error === 'object' &&
        'exitCode' in error &&
        typeof error.exitCode === 'number'
      ) {
        const result = error as { exitCode: number; stdout?: string; stderr?: string };
        return {
          exit_code: result.exitCode,
          stdout: String(result.stdout ?? '').slice(0, 65_536),
          stderr: String(result.stderr ?? '').slice(0, 65_536),
        };
      }
      throw error;
    }
  } finally {
    if (params.pauseAfter) await sandbox.pause();
  }
}

/** Read bounded regular files with no-follow directory descriptors, so even a concurrent
 * symlink replacement cannot redirect capture into agent/platform credentials. */
export async function readTemplateCredentials(sandboxId: string, paths: string[]) {
  if (
    paths.length > 16 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !isCliCredentialPath(path))
  )
    throw new Error('Invalid CLI credential paths');
  if (paths.length === 0) return [];
  const sandbox = await Sandbox.connect(sandboxId, {
    apiKey: process.env.E2B_API_KEY,
    timeoutMs: 60_000,
  });
  const script = `import os,sys,json,stat,base64
paths=json.loads(sys.argv[1])
files=[]
total=0
for path in paths:
    directory=os.open('/home/user',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        parts=path.split('/')
        for part in parts[:-1]:
            child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=directory)
            os.close(directory)
            directory=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size>65536:
                raise ValueError('unsupported credential file')
            with os.fdopen(fd,'rb',closefd=False) as stream:
                data=stream.read(65537)
            total+=len(data)
            if len(data)>65536 or total>262144:
                raise ValueError('credential size exceeded')
            files.append({'path':path,'data':base64.b64encode(data).decode('ascii')})
        finally:
            os.close(fd)
    finally:
        os.close(directory)
print(json.dumps(files))`;
  try {
    const result = await sandbox.commands.run(
      `python3 -c ${shellQuote(script)} ${shellQuote(JSON.stringify(paths))}`,
      { cwd: '/home/user', timeoutMs: 30_000 }
    );
    if (result.exitCode !== 0) throw new Error('capture failed');
    return JSON.parse(result.stdout) as Array<{ path: string; data: string }>;
  } catch {
    // Never expose command output, path targets, or credential bytes on failure.
    throw new Error('CLI credentials could not be captured safely');
  }
}

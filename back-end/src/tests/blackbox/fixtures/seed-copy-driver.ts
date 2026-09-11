import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const directory = process.env.SEED_COPY_TEST_DIRECTORY!;
const record = (event: Record<string, unknown>) =>
  fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify(event) + '\n');
const originalSpawn = cp.spawn;
cp.spawn = new Proxy(originalSpawn, {
  apply(target, thisArgument, argumentsList) {
    const [command, args, options] = argumentsList as [string, string[], cp.SpawnOptions];
    const role = args[args.indexOf('--dbname') + 1].endsWith('/source') ? 'source' : 'target';
    const child = Reflect.apply(target, thisArgument, [
      role === 'target' && process.env.SEED_COPY_TEST_MODE === 'spawn-error'
        ? path.join(directory, 'missing-psql')
        : command,
      args,
      options,
    ]) as cp.ChildProcess;
    child.once('error', () => record({ event: 'error', role }));
    child.once('close', (code, signal) => {
      record({ event: 'close', role, code, signal });
      if (role === 'target') fs.writeFileSync(path.join(directory, 'target-closed'), 'closed');
    });
    return child;
  },
});
syncBuiltinESMExports();

let settled = false;
process.once('beforeExit', (code) => record({ event: 'beforeExit', code, settled }));
import('../../../../scripts/seed-jsonb-stream')
  .then(({ streamCookies }) =>
    streamCookies({
      remoteUrl: 'postgresql://fixture@localhost/source',
      localUrl: 'postgresql://fixture@localhost/target',
      userId: 'fixture',
      domains: [],
    })
  )
  .then(
    (count) => {
      settled = true;
      record({ event: 'resolved', count });
    },
    (error) => {
      settled = true;
      record({ event: 'rejected', message: String(error.message) });
      process.exitCode = 17;
    }
  );

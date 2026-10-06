import fs from 'node:fs';
import path from 'node:path';
const directory = process.env.SEED_COPY_TEST_DIRECTORY!;
const mode = process.env.SEED_COPY_TEST_MODE;
const args = process.argv.slice(2);
const role = args[args.indexOf('--dbname') + 1].endsWith('/source') ? 'source' : 'target';
const record = (event: string) =>
  fs.appendFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ event, role }) + '\n');

async function waitFor(file: string) {
  await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(directory, check);
    const backstop = setTimeout(() => {
      watcher.close();
      reject(new Error(`missing fixture signal: ${file}`));
    }, 15000);
    function check() {
      if (!fs.existsSync(path.join(directory, file))) return;
      clearTimeout(backstop);
      watcher.close();
      resolve();
    }
    check();
  });
}

async function main(): Promise<void> {
  if (role === 'source') {
    if (mode === 'early-target' || mode === 'spawn-error') await waitFor('target-closed');
    else {
      await waitFor('target-ready');
      process.stdout.write('fixture-row\n');
    }
    record('source-finished');
    process.exitCode = mode === 'source-error' ? 23 : 0;
    return;
  }
  if (mode === 'early-target') {
    process.stderr.write('target rejected COPY before source completion\n');
    process.exitCode = 23;
    return;
  }
  fs.writeFileSync(path.join(directory, 'target-ready'), 'ready');
  for await (const chunk of process.stdin) record(`received-${chunk.length}`);
  record('clean-eof');
  process.stdout.write('SEED_STREAM_COUNT=7\n');
}

main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 45;
});

import { runCurationPoolControls } from '../blackbox/archive-curation-pool.controls';
runCurationPoolControls()
  .then(() => process.stdout.write('curation pool controls passed\n'))
  .catch((error: unknown) => {
    process.stderr.write(String(error) + '\n');
    process.exitCode = 1;
  });

#!/usr/bin/env tsx
/**
 * Activate a standby agent-worker build WITHOUT sealing/migrating any workflows.
 *
 * This is the rolling-restart (no-op) cutover path: when a deploy's replay-surface
 * generation is UNCHANGED from the live pointer, the freshly deployed workers are
 * replay-compatible with the current generation queue and only need to be released
 * from standby. The full seal+respawn migration would needlessly reincarnate every
 * open workflow, so instead we just post this build's activation marker (which the
 * standby workers poll for) and retire any superseded markers.
 *
 * Required env: TEMPORAL_WORKER_BUILD_ID (40-char Git SHA),
 * TEMPORAL_WORKER_DEPLOYMENT_TOKEN. DATABASE_URL/TEMPORAL_* must target prod in CI.
 */
import { config } from 'dotenv';
import {
  activateTemporalWorkerBuild,
  cleanupSupersededWorkerActivationMarkers,
} from '../src/providers/temporal';

config();

async function main(): Promise<void> {
  const buildId = process.env.TEMPORAL_WORKER_BUILD_ID;
  const deploymentToken = process.env.TEMPORAL_WORKER_DEPLOYMENT_TOKEN;
  if (!buildId || !deploymentToken) {
    process.stderr.write(
      'TEMPORAL_WORKER_BUILD_ID and TEMPORAL_WORKER_DEPLOYMENT_TOKEN are required\n'
    );
    process.exit(2);
  }
  const marker = await activateTemporalWorkerBuild(buildId, deploymentToken);
  const retired = await cleanupSupersededWorkerActivationMarkers(marker);
  process.stdout.write(
    `Activated worker build ${buildId} (marker ${marker}); retired ${retired} superseded marker(s)\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});

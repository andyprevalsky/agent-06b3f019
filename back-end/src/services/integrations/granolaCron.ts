/** Cron registration for the Granola meeting sync (called from serverCron). */

import cron from 'node-cron';
import { createLogger } from '../../providers/logger';
import { runGranolaSyncJob } from './granolaSync';

export function scheduleGranolaSync(): void {
  const cronLog = createLogger('Cron');
  if (process.env.DISABLE_GRANOLA_SYNC === '1') {
    cronLog.info('Granola sync disabled by DISABLE_GRANOLA_SYNC');
    return;
  }
  // Each user's run is claimed with FOR UPDATE SKIP LOCKED (granolaSync.ts);
  // this guard only stops one process stacking ticks.
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runGranolaSyncJob()
      .then((claimed) => {
        if (claimed > 0) cronLog.info('Granola sync tick', { claimed });
      })
      .catch((err) => {
        cronLog.error('Granola sync job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  cron.schedule('*/5 * * * *', run);
  cronLog.info('Granola sync scheduled (every 5 minutes)');
}

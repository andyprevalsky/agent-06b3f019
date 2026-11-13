/** Bounded, per-provider ticks; cross-replica ownership is enforced by DB leases. */
import cron from 'node-cron';
import { createLogger } from '../../providers/logger';
export function scheduleMeetingSync(provider: string, runSyncJob: () => Promise<number>): void {
  const log = createLogger('Cron');
  const disableKey = `DISABLE_${provider.toUpperCase()}_SYNC`;
  if (process.env[disableKey] === '1') {
    log.info(`${provider} sync disabled by ${disableKey}`);
    return;
  }
  let running = false;
  cron.schedule('*/5 * * * *', () => {
    if (running) return;
    running = true;
    void runSyncJob()
      .then((claimed) => {
        if (claimed > 0) log.info(`${provider} sync tick`, { claimed });
      })
      .catch((error: unknown) =>
        log.error(`${provider} sync job error`, {
          error: error instanceof Error ? error.message : String(error),
        })
      )
      .finally(() => {
        running = false;
      });
  });
  log.info(`${provider} sync scheduled (every 5 minutes)`);
}

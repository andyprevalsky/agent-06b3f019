import cron from 'node-cron';
import { runAgentCardOrgWalletMonitor } from './providers/agentcard/org-wallet-monitor';
import { createLogger } from './providers/logger';
import {
  abandonStaleFundingPending,
  reconcileAbandonedPurchaseFunding,
  reconcileDissolvedPurchaseHolds,
  reconcileFailedPurchaseFundingReclaims,
  reconcileFailedPurchaseRefunds,
  reconcileStaleChargingPurchases,
  reconcileTerminalAgentPurchaseCards,
} from './providers/purchaseCleanup';
import {
  PROACTIVE_SMS_CRON_EXPRESSION,
  PROACTIVE_SMS_TIME_ZONE,
  runProactiveSmsOutreachJobWithLease,
} from './providers/smsSupervisor';
import { runPlaidTransactionSyncJob } from './domains/integrations/service.plaidTransactions';
import { runGmailSyncJob } from './services/integrations/gmailSync';

function scheduleGmailSync(): void {
  if (process.env.DISABLE_GMAIL_SYNC === '1') {
    createLogger('Cron').info('Gmail sync disabled by DISABLE_GMAIL_SYNC');
    return;
  }
  // Start Gmail sync cron job (every 5 minutes, plus immediate run on startup)
  const cronLog = createLogger('Cron');
  const runSync = () => {
    cronLog.info('Running Gmail sync job...');
    runGmailSyncJob().catch((err) => {
      cronLog.error('Gmail sync job error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  runSync();
  cron.schedule('*/5 * * * *', runSync);
  cronLog.info('Gmail sync scheduled (every 5 minutes)');
}

function schedulePlaidSync(): void {
  if (process.env.DISABLE_PLAID_SYNC === '1') {
    createLogger('Cron').info('Plaid sync disabled by DISABLE_PLAID_SYNC');
    return;
  }
  const cronLog = createLogger('Cron');
  const runPlaidSync = () => {
    cronLog.info('Running Plaid transaction sync job...');
    runPlaidTransactionSyncJob().catch((err) => {
      cronLog.error('Plaid transaction sync job error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  cron.schedule('*/5 * * * *', runPlaidSync);
  cronLog.info('Plaid transaction sync scheduled (every 5 minutes)');
}

function schedulePurchaseHoldReconcile(): void {
  if (process.env.DISABLE_PURCHASE_HOLD_RECONCILE === '1') {
    createLogger('Cron').info(
      'Purchase hold reconciliation disabled by DISABLE_PURCHASE_HOLD_RECONCILE'
    );
    return;
  }
  const cronLog = createLogger('Cron');
  let purchaseReconcileRunning = false;
  // Run the reconcilers SEQUENTIALLY. They can otherwise select the same purchase
  // concurrently, and with Promise.all the first rejection would clear the guard
  // while siblings keep running. Each job is isolated so one failure never aborts
  // the rest, and the guard stays held until every job settles.
  const reconcilers: Array<[string, () => Promise<void>]> = [
    ['reconcileDissolvedPurchaseHolds', reconcileDissolvedPurchaseHolds],
    ['reconcileStaleChargingPurchases', reconcileStaleChargingPurchases],
    ['abandonStaleFundingPending', abandonStaleFundingPending],
    ['reconcileAbandonedPurchaseFunding', reconcileAbandonedPurchaseFunding],
    ['reconcileFailedPurchaseRefunds', reconcileFailedPurchaseRefunds],
    ['reconcileFailedPurchaseFundingReclaims', reconcileFailedPurchaseFundingReclaims],
    ['reconcileTerminalAgentPurchaseCards', reconcileTerminalAgentPurchaseCards],
  ];
  const runPurchaseHoldReconcile = () => {
    if (purchaseReconcileRunning) {
      cronLog.info('Purchase hold reconciliation already running; skipping overlapping tick');
      return;
    }
    purchaseReconcileRunning = true;
    cronLog.info('Running purchase hold reconciliation job...');
    void (async () => {
      try {
        for (const [name, reconcile] of reconcilers) {
          try {
            await reconcile();
          } catch (err) {
            cronLog.error('Purchase hold reconciliation job error', {
              job: name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } finally {
        purchaseReconcileRunning = false;
      }
    })();
  };
  cron.schedule('* * * * *', runPurchaseHoldReconcile);
  cronLog.info('Purchase hold reconciliation scheduled (every minute)');
}

function scheduleAgentCardOrgWalletMonitor(): void {
  if (process.env.DISABLE_AGENTCARD_ORG_WALLET_MONITOR === '1') {
    createLogger('Cron').info(
      'AgentCard org-wallet monitor disabled by DISABLE_AGENTCARD_ORG_WALLET_MONITOR'
    );
    return;
  }
  const cronLog = createLogger('Cron');
  let walletMonitorRunning = false;
  const runWalletMonitor = () => {
    if (walletMonitorRunning) {
      cronLog.info('AgentCard org-wallet monitor already running; skipping overlapping tick');
      return;
    }
    walletMonitorRunning = true;
    runAgentCardOrgWalletMonitor()
      .catch((err) => {
        cronLog.error('AgentCard org-wallet monitor error', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        walletMonitorRunning = false;
      });
  };
  runWalletMonitor();
  cron.schedule('* * * * *', runWalletMonitor);
  cronLog.info('AgentCard org-wallet monitor scheduled (every minute)');
}

function scheduleProactiveSmsOutreach(isProduction: boolean): void {
  if (!isProduction || process.env.DISABLE_PROACTIVE_SMS === '1') {
    createLogger('Cron').info('Proactive SMS outreach disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_PROACTIVE_SMS',
    });
    return;
  }
  const cronLog = createLogger('Cron');
  const runProactiveOutreach = () => {
    cronLog.info('Running proactive SMS outreach job...');
    runProactiveSmsOutreachJobWithLease()
      .then((result) => {
        if (!result.acquired) {
          cronLog.info('Proactive SMS outreach skipped; another replica owns the lease');
        }
      })
      .catch((err) => {
        cronLog.error('Proactive SMS outreach job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
  cron.schedule(PROACTIVE_SMS_CRON_EXPRESSION, runProactiveOutreach, {
    timezone: PROACTIVE_SMS_TIME_ZONE,
  });
  cronLog.info('Proactive SMS outreach scheduled', {
    cron: PROACTIVE_SMS_CRON_EXPRESSION,
    timezone: PROACTIVE_SMS_TIME_ZONE,
  });
}

/**
 * Registers all background cron jobs. Contract-test backends should not run
 * unrelated background jobs, so each job self-gates on its DISABLE_* env flag.
 */
export function registerCronJobs(isProduction: boolean): void {
  scheduleGmailSync();
  schedulePlaidSync();
  schedulePurchaseHoldReconcile();
  scheduleAgentCardOrgWalletMonitor();
  scheduleProactiveSmsOutreach(isProduction);
}

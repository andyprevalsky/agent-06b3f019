import cron from 'node-cron';
import { runAgentCardOrgWalletMonitor } from './providers/agentcard/org-wallet-monitor';
import { createLogger } from './providers/logger';
import { SHARED_STEEL_IDENTITY, steelEnvironmentIdentity } from './providers/steel/sessionIdentity';
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
import { runGoogleDataPurgeJob } from './services/integrations/googleDataPurge';
import { runMessagingUploadJobs } from './domains/integrations/uploadService.messagingJobs';
import { reconcileWorkflowLiveness } from './providers/workflowLivenessReconciler';
import { runStuckAgentBugReports } from './domains/agents/stuckAgentBugReportService';
import { cleanupTerminalAgentWorkflowZombies } from './providers/workflowTerminalCleanup';
import { runTerminalAgentBrowserReleaseReconcileWithLease } from './providers/agentCleanup';
import { runTraceArchiveFinalizationRetries } from './providers/traceArchiveFinalizationRetry';
import { runSteelSessionReaperWithLease } from './providers/steel/sessionReaper';
import { recoverConfiguredWorkerProcesses } from './providers/workerProcessRecovery';
import { runProductionSchemaDriftCheck } from './providers/schemaDrift/cron';
import { alertError } from './providers/errorAlert';

function scheduleWorkerProcessRecovery(isProduction: boolean): void {
  if (!isProduction) return;
  const log = createLogger('WorkerProcessRecovery');
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    recoverConfiguredWorkerProcesses()
      .then((rows) => {
        if (rows.length)
          log.info('Existing worker process recovery observed', {
            hosts: rows.map(({ id, phase }) => ({ id, phase })),
          });
      })
      .catch((error) =>
        log.error('Existing worker process recovery held', {
          reason: error instanceof Error ? error.message : 'Unknown recovery result',
        })
      )
      .finally(() => {
        running = false;
      });
  };
  run();
  setInterval(run, 60_000).unref();
}

function scheduleTraceArchiveFinalizationRetries(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_TRACE_ARCHIVE_FINALIZATION_RETRY === '1') {
    cronLog.info('Trace archive finalization retry disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_TRACE_ARCHIVE_FINALIZATION_RETRY',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) {
      cronLog.info('Trace archive finalization retry already running; skipping overlapping tick');
      return;
    }
    running = true;
    runTraceArchiveFinalizationRetries({
      batchSize: 100,
      maxConcurrency: 4,
      deadlineAtMs: Date.now() + 50_000,
    })
      .then((summary) => {
        if (summary.discovered > 0) {
          cronLog.info('Trace archive finalization retry summary', { ...summary });
        }
      })
      .catch((error) => {
        cronLog.error('Trace archive finalization retry failed; obligations retained', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  cron.schedule('* * * * *', run);
  cronLog.info('Trace archive finalization retry scheduled (every minute)');
}

function scheduleTerminalBrowserReleaseReconcile(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_TERMINAL_BROWSER_RELEASE_RECONCILE === '1') {
    cronLog.info('Terminal browser release reconcile disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_TERMINAL_BROWSER_RELEASE_RECONCILE',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) {
      cronLog.info('Terminal browser release reconcile already running; skipping overlapping tick');
      return;
    }
    running = true;
    runTerminalAgentBrowserReleaseReconcileWithLease({
      batchSize: 100,
      deadlineAtMs: Date.now() + 50_000,
    })
      .then(({ acquired, summary }) => {
        if (!acquired) {
          cronLog.info('Terminal browser release reconcile lease held by another replica');
          return;
        }
        if (summary.discovered > 0) {
          cronLog.info('Terminal browser release reconcile summary', { ...summary });
        }
      })
      .catch((error) => {
        cronLog.error('Terminal browser release reconcile failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  cron.schedule('* * * * *', run);
  cronLog.info('Terminal browser release reconcile scheduled (every minute)');
}

function scheduleWorkflowLivenessReconcile(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_WORKFLOW_LIVENESS_RECONCILE === '1') {
    cronLog.info('Workflow liveness reconcile disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_WORKFLOW_LIVENESS_RECONCILE',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) {
      cronLog.info('Workflow liveness reconcile already running; skipping overlapping tick');
      return;
    }
    running = true;
    reconcileWorkflowLiveness()
      .then((summary) => {
        if (summary.sealed > 0 || summary.inconclusive > 0) {
          cronLog.info('Workflow liveness reconcile summary', summary);
        }
      })
      .catch((error) => {
        cronLog.error('Workflow liveness reconcile failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  setInterval(run, 60_000).unref?.();
}

/** Hourly: real prod agent runs not COMPLETED 24h after start get one Report Bug /rca. */
function scheduleStuckAgentBugReports(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_STUCK_AGENT_BUG_REPORTS === '1') {
    cronLog.info('Stuck-agent bug reports disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_STUCK_AGENT_BUG_REPORTS',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) {
      cronLog.info('Stuck-agent bug reports already running; skipping overlapping tick');
      return;
    }
    running = true;
    runStuckAgentBugReports()
      .then((summary) => {
        // Logged every tick so a quiet hour still proves the job ran.
        cronLog.info('Stuck-agent bug reports summary', { ...summary });
      })
      .catch((error) => {
        cronLog.error('Stuck-agent bug reports failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  cron.schedule('23 * * * *', run);
  cronLog.info('Stuck-agent bug reports scheduled (hourly)');
}

/**
 * Hourly: read-only catalog check that applied migrations' RLS, policies (name
 * and definition) and indexes still exist, and that no public table is
 * anon/authenticated-readable with RLS off. A stray db push left prod RLS off
 * for 18 days (2026-10-08) because nothing checked between deploys.
 */
function scheduleSchemaDriftCheck(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_SCHEMA_DRIFT_CHECK === '1') {
    cronLog.info('Schema drift check disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_SCHEMA_DRIFT_CHECK',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runProductionSchemaDriftCheck()
      .then((result) => {
        // Logged every tick so a quiet hour still proves the check ran.
        cronLog.info('Schema drift check summary', {
          acquired: result.acquired,
          ...(result.acquired ? { checked: result.checked, problems: result.problems.length } : {}),
        });
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        cronLog.error('Schema drift check failed', { error: message });
        // A check that cannot run is as silent as no check; say so in #errors.
        alertError({
          source: 'schema_drift',
          message: `Schema drift check failed to run: ${message}`,
        });
      })
      .finally(() => {
        running = false;
      });
  };
  cron.schedule('41 * * * *', run);
  cronLog.info('Schema drift check scheduled (hourly)');
}

function scheduleTemporalWorkflowCleanup(isProduction: boolean): void {
  const cronLog = createLogger('Cron');
  if (!isProduction || process.env.DISABLE_TEMPORAL_WORKFLOW_CLEANUP === '1') {
    cronLog.info('Temporal workflow cleanup disabled', {
      reason: !isProduction ? 'non-production' : 'DISABLE_TEMPORAL_WORKFLOW_CLEANUP',
    });
    return;
  }
  let cleanupRunning = false;
  const runCleanup = () => {
    if (cleanupRunning) {
      cronLog.info('Temporal workflow cleanup already running; skipping overlapping tick');
      return;
    }
    cleanupRunning = true;
    cleanupTerminalAgentWorkflowZombies(
      {},
      {
        batchSize: 100,
        maxConcurrency: 8,
        deadlineAtMs: Date.now() + 50_000,
      }
    )
      .then((summary) => {
        if (summary.discovered > 0) {
          cronLog.info('Temporal workflow cleanup completed', { ...summary });
        }
      })
      .catch((err: unknown) => {
        cronLog.error('Temporal workflow cleanup job error; obligations retained for retry', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        cleanupRunning = false;
      });
  };
  runCleanup();
  cron.schedule('* * * * *', runCleanup);
  cronLog.info('Temporal workflow cleanup scheduled (every minute)');
}

/** Matches the Gmail crash-recovery window; one run should never take longer. */
const CRON_RUN_STALE_MS = 60 * 60 * 1000;

function scheduleGmailSync(): void {
  if (process.env.DISABLE_GMAIL_SYNC === '1') {
    createLogger('Cron').info('Gmail sync disabled by DISABLE_GMAIL_SYNC');
    return;
  }
  // Start Gmail sync cron job (every 5 minutes, plus immediate run on startup)
  const cronLog = createLogger('Cron');
  // Each integration is claimed atomically (claimGmailIntegrationForSync), so
  // instances can share the work; this only stops one process stacking ticks.
  // A run that hangs past the stale window no longer blocks later ticks.
  let runningSince: number | null = null;
  const runSync = () => {
    if (runningSince !== null && Date.now() - runningSince < CRON_RUN_STALE_MS) {
      cronLog.info('Gmail sync already running; skipping overlapping tick');
      return;
    }
    if (runningSince !== null)
      cronLog.warn('Gmail sync previous run exceeded the stale window; starting anyway');
    runningSince = Date.now();
    cronLog.info('Running Gmail sync job...');
    runGmailSyncJob()
      .catch((err) => {
        cronLog.error('Gmail sync job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        runningSince = null;
      });
  };
  runSync();
  cron.schedule('*/5 * * * *', runSync);
  cronLog.info('Gmail sync scheduled (every 5 minutes)');
}

function scheduleGoogleDataPurge(): void {
  if (process.env.DISABLE_GOOGLE_DATA_PURGE === '1') {
    createLogger('Cron').info('Google data purge disabled by DISABLE_GOOGLE_DATA_PURGE');
    return;
  }
  const cronLog = createLogger('Cron');
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runGoogleDataPurgeJob()
      .catch((error: unknown) => {
        cronLog.error('Google data purge job failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  cron.schedule('* * * * *', run);
}

/** Drain durable messaging upload parts, recovering any lost to a restart or crash. */
function scheduleMessagingUploadJobs(): void {
  if (process.env.DISABLE_MESSAGING_UPLOAD_JOBS === '1') {
    createLogger('Cron').info('Messaging upload jobs disabled by DISABLE_MESSAGING_UPLOAD_JOBS');
    return;
  }
  const cronLog = createLogger('Cron');
  const run = () => {
    runMessagingUploadJobs().catch((error: unknown) => {
      cronLog.error('Messaging upload jobs failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  run();
  cron.schedule('* * * * *', run);
}

function schedulePlaidSync(): void {
  if (process.env.DISABLE_PLAID_SYNC === '1') {
    createLogger('Cron').info('Plaid sync disabled by DISABLE_PLAID_SYNC');
    return;
  }
  const cronLog = createLogger('Cron');
  // Each item sync holds a cross-instance lease (claimPlaidItemSync); this only
  // stops one process stacking ticks.
  // A run that hangs past the stale window no longer blocks later ticks.
  let runningSince: number | null = null;
  const runPlaidSync = () => {
    if (runningSince !== null && Date.now() - runningSince < CRON_RUN_STALE_MS) {
      cronLog.info('Plaid transaction sync already running; skipping overlapping tick');
      return;
    }
    if (runningSince !== null)
      cronLog.warn(
        'Plaid transaction sync previous run exceeded the stale window; starting anyway'
      );
    runningSince = Date.now();
    cronLog.info('Running Plaid transaction sync job...');
    runPlaidTransactionSyncJob()
      .catch((err) => {
        cronLog.error('Plaid transaction sync job error', {
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        runningSince = null;
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

/** Surface the Brex→Coinbase hard kill at startup without scheduling a deposit job. */
function reportCoinbaseFiatRailDisabled(): void {
  const cronLog = createLogger('Cron');
  cronLog.info(
    'Brex→Coinbase fiat rail HARD-DISABLED after broken transfers; on-demand fiat pulls are also disabled'
  );
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
function scheduleSteelSessionReaper(): void {
  const cronLog = createLogger('Cron');
  // Every environment reaps only the sessions it created (sessionIdentity.ts), so
  // local stacks run this too; without a key there is nothing to list.
  const sharedIdentity = steelEnvironmentIdentity() === SHARED_STEEL_IDENTITY;
  if (
    (process.env.STEEL_API_KEY ?? '').trim() === '' ||
    process.env.DISABLE_STEEL_SESSION_REAPER === '1' ||
    sharedIdentity
  ) {
    // Two stacks with nothing to tell them apart would carry the same marker and
    // could release each other's live sessions; without a distinct identity the
    // reaper stays off and Steel's own timeout remains the backstop.
    cronLog.info('Steel session reaper disabled', {
      reason:
        process.env.DISABLE_STEEL_SESSION_REAPER === '1'
          ? 'DISABLE_STEEL_SESSION_REAPER'
          : sharedIdentity
            ? 'no distinct environment identity'
            : 'no STEEL_API_KEY',
    });
    return;
  }
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    runSteelSessionReaperWithLease()
      .then((summary) => {
        if (summary !== null && (summary.released > 0 || summary.failed > 0)) {
          cronLog.warn('Steel session reaper summary', { ...summary });
        }
      })
      .catch((error) => {
        cronLog.error('Steel session reaper failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  };
  run();
  cron.schedule('*/5 * * * *', run);
  cronLog.info('Steel session reaper scheduled (every 5 minutes)');
}

export function registerCronJobs(isProduction: boolean): void {
  scheduleWorkerProcessRecovery(isProduction);
  scheduleTraceArchiveFinalizationRetries(isProduction);
  scheduleTemporalWorkflowCleanup(isProduction);
  scheduleWorkflowLivenessReconcile(isProduction);
  scheduleStuckAgentBugReports(isProduction);
  scheduleSchemaDriftCheck(isProduction);
  scheduleTerminalBrowserReleaseReconcile(isProduction);
  scheduleSteelSessionReaper();
  scheduleGmailSync();
  scheduleGoogleDataPurge();
  scheduleMessagingUploadJobs();
  schedulePlaidSync();
  schedulePurchaseHoldReconcile();
  scheduleAgentCardOrgWalletMonitor();
  reportCoinbaseFiatRailDisabled();
  scheduleProactiveSmsOutreach(isProduction);
}

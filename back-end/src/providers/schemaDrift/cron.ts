/**
 * Production wiring for the hourly schema drift check: the shared Postgres
 * lease picks one replica per hour, the catalog read runs on the app's pool in
 * a READ ONLY transaction, and drift alerts #errors through alertError.
 */
import { runTransactionWithRetry } from '../database';
import { alertError } from '../errorAlert';
import { acquireLease } from '../sharedState';
import {
  CATALOG_TRANSACTION_OPTIONS,
  readCatalogInTransaction,
  runSchemaDriftCheck,
  type SchemaDriftCheckResult,
} from './index';

export function runProductionSchemaDriftCheck(): Promise<SchemaDriftCheckResult> {
  return runSchemaDriftCheck({
    acquireLease,
    readCatalog: () =>
      runTransactionWithRetry(readCatalogInTransaction, CATALOG_TRANSACTION_OPTIONS),
    alert: (problems, report) =>
      alertError({
        source: 'schema_drift',
        message: `${problems.length} schema drift problem(s): ${problems.join('; ')}`,
        context: {
          checked: report.checked,
          exposedTables: report.exposedTables.length,
          changedPolicies: report.changedPolicies.length,
          invalidIndexes: report.invalidIndexes.length,
          remedy: 'Restore with a new idempotent migration; never an ad-hoc db push.',
        },
      }),
  });
}

import * as grepRepo from './grepRepo';
import type { GrepResult, ValidatedGrepInput } from './types';

export async function transactionGrepSummary(
  userId: string,
  input: ValidatedGrepInput
): Promise<NonNullable<GrepResult['summaries']>['transactions']> {
  const filters = input.filters.transactions;
  const aggregateRows = await grepRepo.aggregateTransactionGrepRows({
    userId,
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    since: filters?.since,
    until: filters?.until,
    account: filters?.account,
    minAmount: filters?.minAmount,
    maxAmount: filters?.maxAmount,
    status: filters?.status,
    includePendingInTotals: filters?.includePendingInTotals,
  });
  return {
    totals_include_pending: filters?.includePendingInTotals === true,
    currencies: aggregateRows.map((row) => ({
      currency: row.currency,
      outflow: row.outflow?.toString() ?? '0',
      inflow: row.inflow?.toString() ?? '0',
      net: row.net?.toString() ?? '0',
      count: Number(row.count),
    })),
  };
}

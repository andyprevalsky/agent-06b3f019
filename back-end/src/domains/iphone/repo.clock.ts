import type { Transaction } from './types';

export async function databaseNow(tx: Transaction): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}

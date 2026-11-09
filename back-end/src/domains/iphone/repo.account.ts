/** Account eligibility is independent of lease admission and setup. */
import { permitted } from './config';
import type { Transaction } from './types';
export async function accountPermitted(tx: Transaction, userId: string) {
  return permitted(await tx.user.findUnique({ where: { userId } }));
}

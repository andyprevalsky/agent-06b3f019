/** Saved Google password reads for connect / take-control autofill. */

import { prisma } from '../../providers/database';
import { googlePasswordCandidates } from '../../providers/phoneSavedPassword';

/** Enabled Google passwords for one account, newest-used first, decrypted + deduped. */
export async function findGooglePasswordCandidates(userId: string, email: string) {
  return googlePasswordCandidates(prisma, userId, email);
}

import { permitted } from '../../providers/phoneAccountPolicy';
import { getAuthOptions } from '../../providers/authOptions';
import { primitiveDomain } from '../../providers/primitive';
import * as repo from './repo';
import { NEEDS_MINTED_IDENTITY, type PlanContext } from './serviceScenarios';
import { AuthTestSiteError, type CreateAuthTestSiteInput } from './types';
function inboxLocalPart(holderName: string | null): string {
  const local = (holderName ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '');
  return local === '' ? 'member' : local;
}

/** Resolves the identities a scenario's accounts live under, before anything is seeded. */
export async function resolvePlanContext(
  input: CreateAuthTestSiteInput,
  siteId: string,
  realm: string,
  holderName: string | null
): Promise<PlanContext> {
  const ctx: PlanContext = {
    siteId,
    holderName,
    mintedEmail: null,
    mintedPhone: null,
    connectedInbox: null,
  };
  if (input.scenario === 'phone_sms_otp') {
    const { user, device } = await repo.findPhoneSmsOwner(input.userId);
    if (
      !permitted(user) ||
      user?.phone === null ||
      user?.phone === undefined ||
      device?.enabled !== true ||
      device.providerDeviceId === ''
    )
      throw new AuthTestSiteError('Owned cloud phone is not configured', 409);
    ctx.ownedPhone = user.phone;
  }
  if (NEEDS_MINTED_IDENTITY.includes(input.scenario)) {
    const minted = (await getAuthOptions(input.userId, realm)).minted;
    if (minted === null) {
      throw new AuthTestSiteError(
        'No minted account is available for this user; is PRIMITIVE_API_KEY configured?',
        503
      );
    }
    ctx.mintedEmail = minted.email.toLowerCase();
    ctx.mintedPhone = minted.phone;
    if (input.scenario === 'minted_sms_otp' && minted.phone === null) {
      throw new AuthTestSiteError('The minted identity has no phone number to text', 503);
    }
  }
  if (input.scenario === 'email_otp') {
    // The user's own inbox, as if they had linked their mail account. It lives
    // on our mail domain so the run needs no real mailbox.
    const inbox = `${inboxLocalPart(holderName)}.${siteId}@${primitiveDomain().toLowerCase()}`;
    await repo.connectInbox(input.userId, inbox);
    ctx.connectedInbox = inbox;
  }
  return ctx;
}

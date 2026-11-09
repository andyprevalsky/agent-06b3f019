import { BASE_BEHAVIOR } from './serviceScenarioBehaviors';
import { randomBytes } from '../../providers/crypto';
export function phoneSmsPlan(ctx: {
  siteId: string;
  holderName: string | null;
  ownedPhone?: string;
}) {
  const member = {
    email: `member.${ctx.siteId}@example.invalid`,
    password: null,
    memberNumber: randomBytes(6).toString('hex'),
    name: ctx.holderName,
    phone: ctx.ownedPhone ?? null,
    locked: false,
    verified: true,
    origin: 'seed' as const,
  };
  return {
    behavior: {
      ...BASE_BEHAVIOR,
      passwordSignIn: false,
      emailSignIn: 'off' as const,
      smsSignIn: 'code' as const,
    },
    accounts: [member],
    savedPasswords: [],
    ladder: null,
    minted: 'none' as const,
    mintedLogin: null,
    savedSession: null,
    passkeyEmail: null,
    expectedSignInEmail: member.email,
    expectedMemberNumber: member.memberNumber,
    namedAccountEmail: null,
    userSignIn: null,
  };
}

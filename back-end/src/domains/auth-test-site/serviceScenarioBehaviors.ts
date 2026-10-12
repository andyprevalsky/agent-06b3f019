/** Site behaviors the scenario planners start from. */

import type { SiteBehavior } from './types';

export const BASE_BEHAVIOR: SiteBehavior = {
  identifierFirst: false,
  passwordSignIn: true,
  emailSignIn: 'code',
  smsSignIn: 'off',
  passkey: 'off',
  secondFactor: 'none',
  signUp: 'off',
  guest: 'off',
  shop: false,
  memberDiscountPercent: 0,
  membershipFeeCents: 0,
  expireSessionAtOrder: false,
};

export const SHOP: Partial<SiteBehavior> = { shop: true };
export const GUEST_SHOP: Partial<SiteBehavior> = { ...SHOP, signUp: 'open', guest: 'checkout' };
export const MEMBER_PRICE_SHOP: Partial<SiteBehavior> = {
  ...GUEST_SHOP,
  memberDiscountPercent: 10,
};

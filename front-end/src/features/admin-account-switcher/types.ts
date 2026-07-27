import type { AdminDirectoryPerson } from '@/lib/adminUsers';

/** A switchable account: a directory row that resolved to a real userId. */
export interface SwitchableAccount extends AdminDirectoryPerson {
  userId: string;
}

export interface CurrentAccountIdentity {
  userId: string | null;
  label: string;
  /** True while viewing someone else's account with an admin session stashed. */
  isImpersonating: boolean;
}

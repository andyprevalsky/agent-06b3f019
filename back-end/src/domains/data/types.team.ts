export interface TeamSearchScope {
  scope: 'own' | 'shared' | 'all';
  teamId?: string;
  ownerUserId?: string;
  accountId?: string;
}

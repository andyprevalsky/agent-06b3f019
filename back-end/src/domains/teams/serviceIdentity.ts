import * as repo from './repo';
import { TeamError, normalizedEmail } from './types';
export async function requireUser(userId: string) {
  const user = await repo.findUser(userId);
  if (!user) throw new TeamError(404, 'User not found');
  return user;
}
export async function requireMemberUser(userId: string) {
  const user = await requireUser(userId);
  if (user.isAnonymous) throw new TeamError(403, 'Sign in to use teams');
  return {
    ...user,
    email: user.email === null || user.email === '' ? null : normalizedEmail(user.email),
  };
}

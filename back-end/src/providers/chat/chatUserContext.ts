/** Ordinary chat uses the live profile; shared DEMO fixtures never read private profiles. */
import { prisma } from '../database';
import { agentFastMode } from '../demoCacheStore';
import { formatUserContext, USER_PROFILE_SELECT } from '../userProfileContext';

const defaultDependencies = {
  agentFastMode,
  findProfile: (userId: string) =>
    prisma.user.findUnique({ where: { userId }, select: USER_PROFILE_SELECT }),
};

export async function loadChatUserProfileContext(
  agentId: string,
  userId: string,
  dependencies = defaultDependencies
): Promise<string> {
  // DEMO goals replay a shared, goal-keyed fixture. Their cache deliberately
  // excludes dynamic context, including on recorder-account live misses.
  if ((await dependencies.agentFastMode(agentId)).enabled) return '';
  return formatUserContext(await dependencies.findProfile(userId));
}

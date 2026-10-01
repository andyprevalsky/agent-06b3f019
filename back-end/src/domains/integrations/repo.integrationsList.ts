import { prisma } from '../../providers/database';
import { withGoogleScopeHealth } from './integrationScopeHealth';

export async function findIntegrationsByUser(userId: string) {
  const integrations = await prisma.integration.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      emailCredentials: {
        where: {
          email: { not: null },
          OR: [{ accessToken: { not: null } }, { state: 'needs_reconnect' }],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        // Granted scopes stay server-side; only health is returned to the client.
        select: {
          id: true,
          email: true,
          state: true,
          lastErrorReason: true,
          lastFailedSyncAt: true,
          scopes: true,
        },
      },
    },
  });
  return withGoogleScopeHealth(integrations);
}

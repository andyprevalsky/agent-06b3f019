import { prisma } from '../../providers/database';
import { withGoogleScopeHealth } from './integrationScopeHealth';

export async function findIntegrationsByUser(userId: string) {
  const integrations = await prisma.integration.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    include: {
      emailCredentials: {
        where: { email: { not: null }, accessToken: { not: null } },
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

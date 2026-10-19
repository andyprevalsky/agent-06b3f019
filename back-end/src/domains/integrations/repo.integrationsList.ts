import { prisma } from '../../providers/database';
import { findReadableInboxEmails } from '../../providers/authOptionsStore';
import { withGoogleScopeHealth } from './integrationScopeHealth';

export async function findIntegrationsByUser(userId: string) {
  const [integrations, readableInboxEmails] = await Promise.all([
    prisma.integration.findMany({
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
    }),
    findReadableInboxEmails(userId),
  ]);
  // This is the user-scoped Gmail receiving set, not a per-row account or delivery-health claim.
  return withGoogleScopeHealth(integrations).map((integration) =>
    integration.name === 'gmail' ? { ...integration, readableInboxEmails } : integration
  );
}

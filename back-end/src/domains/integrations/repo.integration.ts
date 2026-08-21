/** Single-integration CRUD kept separate from the browser-data repository. */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export async function findIntegrationByUserAndName(userId: string, name: string) {
  return prisma.integration.findUnique({
    where: { userId_name_accountId: { userId, name, accountId: '' } },
  });
}

export async function updateIntegration(
  integrationId: string,
  data: Prisma.IntegrationUpdateInput
) {
  return prisma.integration.update({ where: { id: integrationId }, data });
}

export async function deleteIntegration(integrationId: string) {
  return prisma.integration.delete({ where: { id: integrationId } });
}

import { prisma } from '../../providers/database';

export async function createEntry(data: { name: string; email: string; variant: string | null }) {
  return prisma.waitlist.create({
    data: {
      name: data.name,
      email: data.email,
      variant: data.variant,
    },
  });
}

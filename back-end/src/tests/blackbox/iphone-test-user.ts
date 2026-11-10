import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { ineligiblePhoneFixtureNumber, phoneFixtureNumber } from './phone-fixture-users';
export async function createPhoneFixtureUser(users: string[], phone?: string) {
  const userId = `iphone-blackbox-${randomUUID()}`;
  users.push(userId);
  await prisma.user.create({
    data: {
      userId,
      phone:
        phone === '+19729777432'
          ? phoneFixtureNumber()
          : phone
            ? `+1888${BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 12))
                .toString()
                .padStart(10, '0')
                .slice(-10)}`
            : undefined,
    },
  });
  return userId;
}

/** Keep the old fixed revocation value occupied without changing an existing owner. */
export async function revokePhoneFixtureIdentity(userId: string): Promise<void> {
  const collisionUserId = `iphone-revocation-collision-${randomUUID()}`;
  const phone = '+15550009999';
  const created = await prisma.user.createMany({
    data: [{ userId: collisionUserId, phone }],
    skipDuplicates: true,
  });
  try {
    await prisma.user.update({
      where: { userId },
      data: { phone: ineligiblePhoneFixtureNumber() },
    });
  } finally {
    if (created.count === 1)
      await prisma.user.deleteMany({ where: { userId: collisionUserId, phone } });
  }
}

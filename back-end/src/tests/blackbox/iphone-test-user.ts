import { randomUUID } from 'node:crypto';
import { prisma } from '../../providers/database';
import { phoneFixtureNumber } from './phone-fixture-users';
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

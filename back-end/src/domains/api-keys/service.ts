import crypto from 'crypto';
import * as repo from './repo';
import { createLogger } from '../../providers/logger';

const log = createLogger('ApiKeys');

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

export async function listKeys(userId: string) {
  const keys = await repo.findKeysByUserId(userId);

  // Mask API keys - show only last 4 characters
  const maskedKeys = keys.map((key) => ({
    id: key.id,
    name: key.name,
    maskedApiKey: `...${key.apiKey.slice(-4)}`,
    createdAt: key.createdAt,
  }));

  return { keys: maskedKeys };
}

export async function generateKey(userId: string, name?: string) {
  // Check if user has an active subscription
  const subscription = await repo.findSubscriptionByUserId(userId);

  if (!subscription) {
    throw new ForbiddenError('Active subscription required');
  }

  // Generate 32-character API key (UUID without dashes)
  const apiKey = crypto.randomUUID().replace(/-/g, '');

  const newKey = await repo.createApiKey(
    userId,
    apiKey,
    name !== undefined && name !== '' ? name : null
  );

  log.info('Generated Rose API key', { userId });

  return {
    id: newKey.id,
    name: newKey.name,
    apiKey: newKey.apiKey,
    createdAt: newKey.createdAt,
  };
}

export async function deleteKey(userId: string, id: string) {
  // Verify the key belongs to the user
  const key = await repo.findKeyByIdAndUserId(id, userId);

  if (!key) {
    throw new NotFoundError('API key not found');
  }

  await repo.deleteKeyById(id);

  log.info('Deleted Rose API key', { keyId: id, userId });

  return { success: true };
}

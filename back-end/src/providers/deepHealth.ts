import type { RequestHandler } from 'express';
import { prisma } from './database';
import { createLogger } from './logger';

const log = createLogger('DeepHealth');

interface DeepHealthHandlerOptions {
  checkDatabase?: () => Promise<unknown>;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

async function checkDatabase(): Promise<unknown> {
  return prisma.$queryRaw`SELECT 1`;
}

function logDatabaseError(error: unknown): void {
  log.error('Deep health database check failed', {
    error: error instanceof Error ? error.message : String(error),
  });
}

/** Build the unauthenticated deep-health handler with injectable seams for cemented failure tests. */
export function createDeepHealthHandler(options: DeepHealthHandlerOptions = {}): RequestHandler {
  const databaseCheck = options.checkDatabase ?? checkDatabase;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? logDatabaseError;

  return async (_req, res) => {
    try {
      await databaseCheck();
      res.json({ status: 'ok', db: 'up', timestamp: now().toISOString() });
    } catch (error) {
      onError(error);
      res.status(503).json({
        status: 'error',
        db: 'down',
        timestamp: now().toISOString(),
      });
    }
  };
}

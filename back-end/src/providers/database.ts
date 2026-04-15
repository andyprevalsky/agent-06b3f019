import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import { createLogger } from './logger';

// Ensure env vars are loaded before accessing DATABASE_URL
dotenv.config();

const log = createLogger('Prisma');
const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Retryable Prisma error codes:
// P1001 - Can't reach database server
// P1017 - Server has closed the connection (Supabase pooler idle timeout)
// P2024 - Timed out fetching a new connection from the pool
const RETRYABLE_ERROR_CODES = new Set(['P1001', 'P1017', 'P2024']);

// Add connection pool parameters if not already present
function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL ?? '';

  // Production (Supabase pooler) can handle 250 connections; local Docker Postgres
  // uses direct connections that each consume ~10MB, so cap at 30 to avoid OOM.
  const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
  const defaultPoolSize = isLocal ? 30 : 250;

  const params: string[] = [];
  if (!url.includes('connection_limit')) params.push(`connection_limit=${defaultPoolSize}`);
  if (!url.includes('pool_timeout')) params.push('pool_timeout=30');

  if (params.length === 0) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.join('&')}`;
}

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    // Connection pool configuration for Supabase Transaction Pooler (port 6543)
    datasources: {
      db: {
        url: getConnectionUrl(),
      },
    },
  }).$extends({
    query: {
      async $allOperations({ operation, model, args, query }) {
        const maxRetries = 3;
        let lastError;

        // eslint-disable-next-line no-restricted-syntax -- Prisma $extends middleware can't use retryWithBackoff (wraps query(args) inside $allOperations)
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await query(args);
          } catch (error: unknown) {
            lastError = error;
            const prismaError = error as { code?: string };

            if (
              typeof prismaError.code === 'string' &&
              RETRYABLE_ERROR_CODES.has(prismaError.code) &&
              attempt < maxRetries
            ) {
              log.warn(
                `${prismaError.code} on ${model}.${operation} (attempt ${attempt}/${maxRetries}), retrying...`
              );
              await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
              continue;
            }

            throw error;
          }
        }

        throw lastError;
      },
    },
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

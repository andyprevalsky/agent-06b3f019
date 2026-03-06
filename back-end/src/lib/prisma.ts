import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

// Ensure env vars are loaded before accessing DATABASE_URL
dotenv.config();

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Retryable Prisma error codes:
// P1001 - Can't reach database server
// P2024 - Timed out fetching a new connection from the pool
const RETRYABLE_ERROR_CODES = new Set(['P1001', 'P2024']);

// Add connection pool parameters if not already present
function getConnectionUrl(): string {
  const url = process.env.DATABASE_URL || '';

  const params: string[] = [];
  if (!url.includes('connection_limit')) params.push('connection_limit=25');
  if (!url.includes('pool_timeout')) params.push('pool_timeout=20');

  if (params.length === 0) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${params.join('&')}`;
}

export const prisma =
  globalForPrisma.prisma ||
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

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await query(args);
          } catch (error: any) {
            lastError = error;

            if (RETRYABLE_ERROR_CODES.has(error.code) && attempt < maxRetries) {
              console.log(`[Prisma] ${error.code} on ${model}.${operation} (attempt ${attempt}/${maxRetries}), retrying...`);
              await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
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


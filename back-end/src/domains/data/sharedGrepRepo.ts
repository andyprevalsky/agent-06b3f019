/**
 * Data domain repo: pieces shared by every grep query builder.
 */

import { Prisma } from '@prisma/client';

export function regexPredicate(
  expression: Prisma.Sql,
  pattern: string,
  caseInsensitive: boolean
): Prisma.Sql {
  if (pattern.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return caseInsensitive
    ? Prisma.sql`${expression} ~* ${pattern}`
    : Prisma.sql`${expression} ~ ${pattern}`;
}

export function pageSize(limit: number, offset: number): number {
  return Math.max(1, limit + offset);
}

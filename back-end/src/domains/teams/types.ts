export type {
  TeamDataGrant,
  TeamAccessFilter,
  SharedProjectDto,
  TeamContext,
} from '../../providers/teamAccess';
export type { Prisma, Team, TeamMember } from '@prisma/client';

export interface MemberDto {
  id: string;
  userId: string | null;
  email: string | null;
  name: string | null;
  role: string;
  status: string;
  onRose: boolean;
  inviteDeliveryStatus: string;
}
export interface ShareableAccount {
  id: string;
  integrationId: string;
  provider: string;
  accountId: string;
  accountEmail: string | null;
  label: string | null;
  name: string;
  status: string;
  ownerUserId: string;
}
export class TeamError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string
  ) {
    super(message);
  }
}

export function normalizedEmail(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())
  ) {
    throw new TeamError(400, 'A valid email address is required');
  }
  return value.trim().toLowerCase();
}
export function teamName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.trim().length > 100 ||
    /[\r\n]/.test(value)
  ) {
    throw new TeamError(400, 'Team name must be 1–100 characters');
  }
  return value.trim();
}
export function objectBody(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  ) {
    throw new TeamError(400, 'Invalid body');
  }
  return value as Record<string, unknown>;
}
export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    throw new TeamError(404, 'Not found');
  return value;
}

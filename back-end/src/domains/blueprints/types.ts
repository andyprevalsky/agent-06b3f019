/**
 * Blueprints domain types — interfaces and type aliases.
 */

export type { Prisma } from '@prisma/client';

export interface BlueprintFeedback {
  rating: number;
  issueType: string | null;
  comment: string | null;
  helpImprove: boolean;
  agentId?: string;
  submittedAt: string;
}

export interface BlueprintMetadata {
  feedback?: BlueprintFeedback;
  [key: string]: unknown;
}

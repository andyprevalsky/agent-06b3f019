import { z } from 'zod';

// Memory entry stored in shared memory
export interface MemoryEntry {
  timestamp: string;
  type: string;
  message_id?: string;
  content: string;
  files?: Array<{
    original_filename: string;
    mime_type: string;
  }>;
}

export interface CachedMemory {
  content: MemoryEntry[];
  hash: string;
}

// Validation schemas
export const appendEntrySchema = z.object({
  entry: z.object({
    type: z.string(),
    message_id: z.string().optional(),
    content: z.string(),
    files: z
      .array(
        z.object({
          original_filename: z.string(),
          mime_type: z.string(),
        })
      )
      .optional(),
  }),
});

export type AppendEntryInput = z.infer<typeof appendEntrySchema>;

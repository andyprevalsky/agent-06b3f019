import { z } from 'zod';
import { DISPLAY_MAX_ITEMS } from '../../providers/display/cli';

/**
 * One item to display. Exactly one source:
 *   url             public http(s) image/video, fetched server-side
 *   file            a file already in this agent's tree (original_filename) or
 *                   one of the owner's storage paths (`<userId>/...`)
 *   content_base64  raw bytes (the sandbox `rose-display` CLI), with filename
 */
export const displayItemSchema = z
  .object({
    url: z.string().min(1).max(4096).optional(),
    file: z.string().min(1).max(1024).optional(),
    content_base64: z.string().min(1).optional(),
    filename: z.string().min(1).max(255).optional(),
  })
  .refine(
    (item) =>
      [item.url, item.file, item.content_base64].filter((value) => value !== undefined).length ===
      1,
    { message: 'each item needs exactly one of url, file or content_base64' }
  );

/** POST /api/display/:agentId */
export const displayRequestSchema = z.object({
  items: z.array(displayItemSchema).min(1).max(DISPLAY_MAX_ITEMS),
  caption: z.string().max(2000).optional(),
});

export type DisplayItemInput = z.infer<typeof displayItemSchema>;
export type DisplayRequestBody = z.infer<typeof displayRequestSchema>;

export const displayAgentIdSchema = z.string().uuid();

export interface DisplayFilePointer {
  id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

export interface DisplayItemResult {
  index: number;
  status: 'posted' | 'duplicate';
  message_id: string;
  sha256: string;
  mime_type: string;
  file_pointer: DisplayFilePointer;
}

export interface DisplayResult {
  agent_id: string;
  posted_count: number;
  duplicate_count: number;
  items: DisplayItemResult[];
}

import { z } from 'zod';

// Literal caps (mirrored in config.ts): types is the lowest layer.
const MAX_ITEMS = 20;
const MAX_OPTIONS = 9;
const MAX_BUNDLE_FILES = 500;

/**
 * A multi-file site or model (the `rose` CLI: a directory, or an .html/.gltf/
 * .obj plus the files it references). `entry` is the page (.html) or model
 * file to show; every path is bundle-relative and served under one URL prefix.
 */
export const displayBundleInputSchema = z
  .object({
    entry: z.string().min(1).max(512),
    files: z
      .array(
        z.object({ path: z.string().min(1).max(512), content_base64: z.string() }).strict()
      )
      .min(1)
      .max(MAX_BUNDLE_FILES),
  })
  .strict();

/**
 * One item to display. Exactly one source:
 *   url             public http(s) image/video/PDF/model/HTML, fetched server-side
 *   file            a file already in this agent's tree (original_filename) or
 *                   one of the owner's storage paths (`<userId>/...`); an .html
 *                   or .gltf/.obj brings the tree files it references along
 *   content_base64  raw bytes (the sandbox `rose` CLI), with filename
 *   bundle          several files (the sandbox `rose` CLI), with an entry
 */
export const displayItemSchema = z
  .object({
    url: z.string().min(1).max(4096).optional(),
    file: z.string().min(1).max(1024).optional(),
    content_base64: z.string().min(1).optional(),
    bundle: displayBundleInputSchema.optional(),
    filename: z.string().min(1).max(255).optional(),
  })
  .refine(
    (item) =>
      [item.url, item.file, item.content_base64, item.bundle].filter(
        (value) => value !== undefined
      ).length === 1,
    { message: 'each item needs exactly one of url, file, content_base64 or bundle' }
  );

export const displayOptionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  recommended: z.boolean().optional(),
});

/** POST /api/agent-tools/:agentId/display */
export const displayRequestSchema = z
  .object({
    items: z.array(displayItemSchema).max(MAX_ITEMS).default([]),
    caption: z.string().max(4000).optional(),
    placement: z.enum(['inline', 'pinned']).default('inline'),
    options: z.array(displayOptionSchema).max(MAX_OPTIONS).optional(),
    allow_other: z.boolean().optional(),
    /** Idempotency for pinned questions: same key → same question (and answer). */
    request_key: z.string().min(1).max(200).optional(),
    /** Agents-worker callers: the workflow that waits for the answer. */
    workflow_id: z.string().min(1).max(300).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.placement === 'inline' && body.items.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'inline display needs 1–20 items' });
    }
    if (body.placement === 'pinned' && (body.caption ?? '').trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['caption'],
        message: 'a pinned question needs a caption (the question text)',
      });
    }
    if (
      body.placement === 'pinned' &&
      (body.options ?? []).length === 0 &&
      body.allow_other === false
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'a pinned question needs options or allow_other',
      });
    }
    if (
      body.placement === 'inline' &&
      (body.options !== undefined || body.allow_other !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['placement'],
        message: 'options and allow_other need placement "pinned"',
      });
    }
  });

/** POST /api/agent-tools/:agentId/messages (send_message_to_user, FYI only) */
export const messageRequestSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  inline_view: z
    .object({
      view: z.string().regex(/^[a-z0-9-]{1,64}$/, 'a published inline view name ([a-z0-9-]+)'),
      props: z.record(z.unknown()).optional(),
    })
    .optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

/** POST /api/agent-tools/:agentId/approvals */
export const approvalRequestSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  request_key: z.string().min(1).max(200).optional(),
});

/** POST /api/agents/:id/questions/:questionId/answer (the UI's pinned card) */
export const answerQuestionSchema = z
  .object({
    answer: z.string().max(4000).optional(),
    dismiss: z.boolean().optional(),
  })
  .refine((body) => body.dismiss === true || (body.answer ?? '').trim().length > 0, {
    message: 'send a non-empty answer, or dismiss: true',
  });

/** GET /api/agent-tools/:agentId/requests/:requestId?wait=<seconds> */
export const waitQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(30).default(0),
});

export const agentToolsAgentIdSchema = z.string().uuid();

export type DisplayItemInput = z.infer<typeof displayItemSchema>;
export type DisplayOption = z.infer<typeof displayOptionSchema>;
export type DisplayRequestBody = z.infer<typeof displayRequestSchema>;
export type MessageRequestBody = z.infer<typeof messageRequestSchema>;
export type ApprovalRequestBody = z.infer<typeof approvalRequestSchema>;

/** Who is calling: a code-agent sandbox (token) or a Rose agent (agents worker). */
export type AgentToolsCaller =
  | {
      kind: 'code_agent';
      userId: string;
      agentId: string;
      provider: 'claude' | 'codex' | null;
      taskId: string | null;
    }
  | { kind: 'agent'; userId: string | null; agentId: string };

/** Persisted on messages and attention rows so the UI can say "<agent> asks". */
export interface RequestingAgent {
  kind: 'code_agent' | 'agent';
  agent_id: string;
  label: string;
  provider?: 'claude' | 'codex';
  task_id?: string;
}

/** What the UI renders: page/bundle/model/pdf in a sandboxed frame, image/video natively. */
export type DisplayKind = 'page' | 'bundle' | 'model' | 'image' | 'video' | 'pdf';

export interface DisplayFilePointer {
  id: string;
  /** image/video/page: the stored file; bundle/model/pdf: the bundle manifest. */
  storage_path: string;
  original_filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  kind: DisplayKind;
  /**
   * page/bundle/model/pdf: frame this URL (sandboxed usercontent origin,
   * DISPLAY_IFRAME_SANDBOX), never storage. Absent for image/video.
   */
  usercontent_url?: string;
  /** bundle/model/pdf: the content-addressed bundle behind usercontent_url. */
  bundle?: { hash: string; entry: string; source: string; file_count: number };
}

export interface DisplayItemResult {
  index: number;
  status: 'posted' | 'duplicate' | 'attached';
  message_id: string | null;
  sha256: string;
  mime_type: string;
  kind: DisplayKind;
  file_pointer: DisplayFilePointer;
}

export interface DisplayResult {
  agent_id: string;
  placement: 'inline' | 'pinned';
  posted_count: number;
  duplicate_count: number;
  items: DisplayItemResult[];
  question?: {
    /** null for route "agent": nothing is stored here, the caller asks via L-A2A. */
    request_id: string | null;
    status: 'pending' | 'answered' | 'rejected' | 'route_to_agent';
    deliver_to: 'user' | 'agent';
    agent_id: string;
    message_id: string | null;
    /** The stored answer when the question was already answered (retried call). */
    response: string | null;
  };
}

export interface RequestState {
  id: string;
  kind: 'approval' | 'question';
  status: 'pending' | 'answered' | 'rejected';
  response: string | null;
  user_message: string | null;
  selected_option: { index: number; label: string } | null;
  deliver_to: 'user' | 'agent';
  answered_by: 'user' | 'agent' | null;
}

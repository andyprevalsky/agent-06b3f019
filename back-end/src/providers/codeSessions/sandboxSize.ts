/**
 * C16: code-agent sandbox sizes. E2B fixes CPU and memory per template build,
 * so every (vCPU, memory) point of a configurable grid is its own template and
 * a resize moves the persistent code session into a new sandbox (W5b
 * checkpoint → restore → `--resume`). CPU and memory adapt independently.
 *
 *   rose env size [--cpu N] [--memory-gb M] --reason …   (in-sandbox CLI / MCP)
 *     └─ POST /api/agent-tools/:agentId/environment/size
 *          requestSandboxResize: a missing flag keeps that dimension · closest
 *          built template satisfying both (cpu ≥ N, memory ≥ M) · per-dimension
 *          cap (403) · per-dimension cooldown and no immediate reverse of the
 *          same dimension (409) · reason required (400)
 *          └─ CodeSessionResize PENDING ──► 202
 *   attached code-agent activity ── keepalive ──► resize_requested
 *     └─ POST /api/{claude,codex}-code-session/:taskId/resize {request_id}
 *          performSandboxResize: claim (PENDING → RUNNING, idempotent)
 *            ├─ stop the old CLI, close its task (the lease stays with the spawn)
 *            ├─ create(goal = resize turn): acquire sees the wanted size ≠ held size
 *            │    → checkpoint the held sandbox → new sandbox from the size's
 *            │      template → restore (branch, commits, files, CLI log)
 *            │      → kill the held sandbox → `claude --resume` / `codex resume`
 *            ├─ DONE (newTaskId) ──► the activity reattaches to the new task
 *            └─ failure → FAILED, continue on the old size with a turn that says so
 *   a session with no attached activity applies a PENDING request on its next spawn.
 *
 * Size of a new session: its Project's `sandboxSize` {cpu, memoryGb}, else the
 * deployment default. The local Mac target has no size (not applicable).
 *
 * 10k agents: each call reads one task row, one session row and at most
 * RESIZE_HISTORY rows of that session's own resize history (indexed by
 * codeSessionId); keepalive adds one indexed read. No shared row or counter.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { isLocalClaudeCodeSandboxId } from '../claudeCodeLocalSession';
import { isLocalDeviceSandboxId } from '../localDevices/hub';
import { isRoseDevUser } from '../../utils/roseDevAccess';
import type { CodeSessionRow } from './store';

const log = createLogger('CodeSandboxSize');

export type SandboxProvider = 'claude' | 'codex';
export type SizeDimension = 'cpu' | 'memoryGb';
export const SIZE_DIMENSIONS: readonly SizeDimension[] = ['cpu', 'memoryGb'];

/** vCPUs and memory (GB) of one sandbox template. */
export interface SandboxSize {
  cpu: number;
  memoryGb: number;
}

/** The template grid the sized build config produces (e2b-templates/sized-templates.json). */
export const DEFAULT_SANDBOX_GRID: { cpu: number[]; memoryGb: number[] } = {
  cpu: [2, 4, 8],
  memoryGb: [4, 8, 16],
};

const DEFAULT_CODEX_TEMPLATE = 'codex-code';
const DEFAULT_COOLDOWN_MIN = 10;
const DEFAULT_REVERSE_WINDOW_MIN = 30;
/** A RUNNING claim older than this was abandoned (backend restart mid-resize). */
const RESIZE_STALE_MS = 15 * 60 * 1000;
const RESIZE_HISTORY = 10;
export const RESIZE_REASON_MAX = 1000;
const DIMENSION_LABEL: Record<SizeDimension, string> = { cpu: 'CPU', memoryGb: 'Memory' };

function positiveInts(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = value.filter((entry): entry is number => Number.isInteger(entry) && entry > 0);
  return out.length === value.length ? [...new Set(out)].sort((a, b) => a - b) : null;
}

/** CODE_SANDBOX_GRID (`{"cpu":[2,4,8],"memoryGb":[4,8,16]}`), else the default grid. */
export function sandboxGrid(): { cpu: number[]; memoryGb: number[] } {
  const raw = process.env.CODE_SANDBOX_GRID?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { cpu?: unknown; memoryGb?: unknown };
      const cpu = positiveInts(parsed.cpu);
      const memoryGb = positiveInts(parsed.memoryGb);
      if (cpu !== null && memoryGb !== null) return { cpu, memoryGb };
    } catch {
      // fall through to the warning
    }
    log.warn('CODE_SANDBOX_GRID is invalid; using the default grid');
  }
  return DEFAULT_SANDBOX_GRID;
}

export function gridSizes(): SandboxSize[] {
  const grid = sandboxGrid();
  return grid.cpu.flatMap((cpu) => grid.memoryGb.map((memoryGb) => ({ cpu, memoryGb })));
}

export function sizeKey(size: SandboxSize): string {
  return `${size.cpu}x${size.memoryGb}`;
}

export function sameSize(a: SandboxSize, b: SandboxSize): boolean {
  return a.cpu === b.cpu && a.memoryGb === b.memoryGb;
}

export function sizeLabel(size: SandboxSize): string {
  return `${size.cpu} vCPU, ${size.memoryGb} GB RAM`;
}

function onGrid(size: SandboxSize): boolean {
  return gridSizes().some((point) => sameSize(point, size));
}

function intEnv(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** CODE_SANDBOX_DEFAULT_CPU / _MEMORY_GB (on the grid), else the grid's smallest point. */
export function defaultSandboxSize(): SandboxSize {
  const grid = sandboxGrid();
  const smallest = { cpu: grid.cpu[0], memoryGb: grid.memoryGb[0] };
  const configured = {
    cpu: intEnv('CODE_SANDBOX_DEFAULT_CPU') ?? smallest.cpu,
    memoryGb: intEnv('CODE_SANDBOX_DEFAULT_MEMORY_GB') ?? smallest.memoryGb,
  };
  return onGrid(configured) ? configured : smallest;
}

/** Size of the sandbox a session holds (sessions from before C16 hold the default size). */
export function heldSandboxSize(
  session: Pick<CodeSessionRow, 'sandboxCpu' | 'sandboxMemoryGb'>
): SandboxSize {
  const fallback = defaultSandboxSize();
  return {
    cpu: session.sandboxCpu ?? fallback.cpu,
    memoryGb: session.sandboxMemoryGb ?? fallback.memoryGb,
  };
}

function isDimension(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

/** A stored `{cpu?, memoryGb?}` (project default); a missing dimension takes the default. */
export function parseSandboxSize(value: unknown): SandboxSize | null {
  if (typeof value !== 'object' || value === null) return null;
  const { cpu, memoryGb } = value as { cpu?: unknown; memoryGb?: unknown };
  if (!isDimension(cpu) && !isDimension(memoryGb)) return null;
  const fallback = defaultSandboxSize();
  return {
    cpu: isDimension(cpu) ? cpu : fallback.cpu,
    memoryGb: isDimension(memoryGb) ? memoryGb : fallback.memoryGb,
  };
}

function minutesEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

export function resizeCooldownMs(): number {
  return minutesEnv('CODE_SANDBOX_RESIZE_COOLDOWN_MIN', DEFAULT_COOLDOWN_MIN) * 60_000;
}

export function resizeReverseWindowMs(): number {
  return minutesEnv('CODE_SANDBOX_RESIZE_REVERSE_WINDOW_MIN', DEFAULT_REVERSE_WINDOW_MIN) * 60_000;
}

/** Template name the sized build config gives a grid point. */
export function sizedTemplateName(provider: SandboxProvider, size: SandboxSize): string {
  return `${provider === 'codex' ? 'codex-code' : 'claude-code'}-c${size.cpu}-m${size.memoryGb}`;
}

type TemplateMap = Partial<Record<SandboxProvider, Record<string, string>>>;

/**
 * E2B_SANDBOX_TEMPLATES: `grid` (every grid point is built under its
 * sizedTemplateName) or JSON `{"claude":{"4x8":"claude-code-c4-m8"},…}`.
 */
function configuredTemplates(): TemplateMap | 'grid' {
  const raw = process.env.E2B_SANDBOX_TEMPLATES?.trim();
  if (!raw) return {};
  if (raw === 'grid') return 'grid';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null) return parsed as TemplateMap;
  } catch {
    // fall through to the warning
  }
  log.warn('E2B_SANDBOX_TEMPLATES is neither "grid" nor JSON; sized templates disabled');
  return {};
}

function currentTemplate(provider: SandboxProvider): string | null {
  if (provider === 'claude') return process.env.E2B_CLAUDE_CODE_TEMPLATE_ID?.trim() || null;
  return process.env.E2B_CODEX_CODE_TEMPLATE_ID?.trim() || DEFAULT_CODEX_TEMPLATE;
}

/**
 * Template for (provider, size). Without a configured sized template only the
 * default size is available (the current template); another size is never
 * silently mapped to a template of a different size.
 */
export function sandboxTemplateFor(provider: SandboxProvider, size: SandboxSize): string | null {
  if (!onGrid(size)) return null;
  const configured = configuredTemplates();
  if (configured === 'grid') return sizedTemplateName(provider, size);
  const named = configured[provider]?.[sizeKey(size)];
  if (typeof named === 'string' && named.trim() !== '') return named.trim();
  return sameSize(size, defaultSandboxSize()) ? currentTemplate(provider) : null;
}

export function availableSizes(provider: SandboxProvider): SandboxSize[] {
  return gridSizes().filter((size) => sandboxTemplateFor(provider, size) !== null);
}

/**
 * The built template closest to `want` that satisfies it (cpu ≥ want.cpu and
 * memory ≥ want.memoryGb): least relative excess, then fewer vCPUs.
 */
export function closestAvailableSize(
  provider: SandboxProvider,
  want: SandboxSize
): SandboxSize | null {
  const excess = (size: SandboxSize) =>
    (size.cpu - want.cpu) / want.cpu + (size.memoryGb - want.memoryGb) / want.memoryGb;
  const fits = availableSizes(provider).filter(
    (size) => size.cpu >= want.cpu && size.memoryGb >= want.memoryGb
  );
  fits.sort((a, b) => excess(a) - excess(b) || a.cpu - b.cpu || a.memoryGb - b.memoryGb);
  return fits[0] ?? null;
}

/** Largest vCPUs / memory this user's code agents may resize to. */
export async function maxSizeFor(userId: string): Promise<SandboxSize> {
  const grid = sandboxGrid();
  const top = {
    cpu: grid.cpu[grid.cpu.length - 1],
    memoryGb: grid.memoryGb[grid.memoryGb.length - 1],
  };
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { codeSandboxMaxCpu: true, codeSandboxMaxMemoryGb: true },
  });
  const fallback = isRoseDevUser(userId)
    ? top
    : {
        cpu: intEnv('CODE_SANDBOX_MAX_CPU') ?? 4,
        memoryGb: intEnv('CODE_SANDBOX_MAX_MEMORY_GB') ?? 8,
      };
  return {
    cpu: user?.codeSandboxMaxCpu ?? fallback.cpu,
    memoryGb: user?.codeSandboxMaxMemoryGb ?? fallback.memoryGb,
  };
}

type ResizeRow = Awaited<ReturnType<typeof prisma.codeSessionResize.findFirst>> & object;

function fromSize(row: ResizeRow): SandboxSize {
  return { cpu: row.fromCpu, memoryGb: row.fromMemoryGb };
}

function toSize(row: ResizeRow): SandboxSize {
  return { cpu: row.toCpu, memoryGb: row.toMemoryGb };
}

function isStaleRunning(row: ResizeRow, now: Date): boolean {
  return (
    row.status === 'RUNNING' &&
    row.startedAt !== null &&
    now.getTime() - row.startedAt.getTime() > RESIZE_STALE_MS
  );
}

/** Newest PENDING or live RUNNING request of a session (abandoned claims are failed). */
export async function activeResizeFor(
  codeSessionId: string,
  now = new Date()
): Promise<ResizeRow | null> {
  const row = await prisma.codeSessionResize.findFirst({
    where: { codeSessionId, status: { in: ['PENDING', 'RUNNING'] } },
    orderBy: { requestedAt: 'desc' },
  });
  if (row === null) return null;
  if (isStaleRunning(row, now)) {
    await prisma.codeSessionResize.updateMany({
      where: { id: row.id, status: 'RUNNING' },
      data: { status: 'FAILED', error: 'abandoned while running', completedAt: now },
    });
    return null;
  }
  return row;
}

/**
 * Size a spawn of this session should run on: an active resize request's
 * target, else the size the session already holds; a brand-new session takes
 * its project's default size.
 */
export async function wantedSessionSize(
  session: CodeSessionRow | null,
  projectSize: unknown
): Promise<SandboxSize> {
  const fallback = parseSandboxSize(projectSize) ?? defaultSandboxSize();
  if (session === null) return fallback;
  const active = await activeResizeFor(session.id);
  if (active !== null) return toSize(active);
  if (session.sandboxCpu !== null || session.sandboxMemoryGb !== null) {
    return heldSandboxSize(session);
  }
  const fresh = session.sandboxId === null && session.latestCheckpointSeq === 0;
  return fresh ? fallback : defaultSandboxSize();
}

/**
 * Size + template for a spawn: the closest built template satisfying the
 * wanted size, else the default size. A size preference never blocks a
 * session from starting.
 */
export async function resolveSpawnSandbox(
  session: CodeSessionRow | null,
  provider: SandboxProvider,
  projectSize: unknown
): Promise<{ size: SandboxSize; templateId: string | null }> {
  const wanted = await wantedSessionSize(session, projectSize);
  const size = closestAvailableSize(provider, wanted) ?? defaultSandboxSize();
  if (!sameSize(size, wanted)) {
    log.warn('No template built for the wanted sandbox size; using the closest built one', {
      provider,
      wanted: sizeKey(wanted),
      size: sizeKey(size),
      codeSessionId: session?.id,
    });
  }
  return { size, templateId: sandboxTemplateFor(provider, size) };
}

// ── requests ──

export class SandboxResizeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'SandboxResizeError';
  }
}

export interface SizeView {
  cpu: number;
  memory_gb: number;
}

export interface ResizeRequestView {
  request_id: string;
  status: string;
  from: SizeView;
  to: SizeView;
  reason: string;
  requested_at: string;
  completed_at: string | null;
  new_task_id: string | null;
  error: string | null;
}

export function sizeView(size: SandboxSize): SizeView {
  return { cpu: size.cpu, memory_gb: size.memoryGb };
}

export function resizeView(row: ResizeRow): ResizeRequestView {
  return {
    request_id: row.id,
    status: row.status.toLowerCase(),
    from: sizeView(fromSize(row)),
    to: sizeView(toSize(row)),
    reason: row.reason,
    requested_at: row.requestedAt.toISOString(),
    completed_at: row.completedAt?.toISOString() ?? null,
    new_task_id: row.newTaskId,
    error: row.error,
  };
}

function providerOf(codeProvider: string | null | undefined): SandboxProvider {
  return codeProvider === 'codex' ? 'codex' : 'claude';
}

/** Task + session the request comes from, or the reason resizing does not apply. */
async function resizableSession(
  userId: string,
  agentId: string,
  taskId: string | null
): Promise<{ task: { id: string }; session: CodeSessionRow }> {
  if (taskId === null) {
    throw new SandboxResizeError(
      403,
      'NOT_A_CODE_SESSION',
      'Only a code-agent session can change its environment size'
    );
  }
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: taskId },
    select: { id: true, agentId: true, sandboxId: true, status: true, codeSessionId: true },
  });
  if (task === null || task.agentId !== agentId) {
    throw new SandboxResizeError(404, 'SESSION_NOT_FOUND', 'Code session not found');
  }
  if (isLocalDeviceSandboxId(task.sandboxId) || isLocalClaudeCodeSandboxId(task.sandboxId)) {
    throw new SandboxResizeError(
      409,
      'NOT_APPLICABLE',
      'Not applicable: this session runs on a local machine, not in a sized cloud sandbox. ' +
        'Its CPU and memory are that machine’s own.'
    );
  }
  if (task.status === 'CLOSED') {
    throw new SandboxResizeError(409, 'SESSION_CLOSED', 'This code session has ended');
  }
  const session =
    task.codeSessionId !== null
      ? await prisma.codeSession.findUnique({ where: { id: task.codeSessionId } })
      : null;
  if (session === null || session.userId !== userId || session.state === 'RETIRED') {
    throw new SandboxResizeError(
      409,
      'NOT_APPLICABLE',
      'Not applicable: this sandbox is not a persistent code session, so it cannot move to another size'
    );
  }
  return { task, session };
}

async function resizeHistory(codeSessionId: string): Promise<ResizeRow[]> {
  return prisma.codeSessionResize.findMany({
    where: { codeSessionId },
    orderBy: { requestedAt: 'desc' },
    take: RESIZE_HISTORY,
  });
}

function changes(row: ResizeRow, dim: SizeDimension): boolean {
  return fromSize(row)[dim] !== toSize(row)[dim];
}

/**
 * Guardrails for a new request, per dimension it changes: the same pending
 * request is returned (idempotent retry); another in flight, a change of the
 * same dimension inside the cooldown, or the reverse of that dimension's last
 * change inside its window is refused (409).
 */
function checkHistory(
  history: ResizeRow[],
  held: SandboxSize,
  target: SandboxSize,
  now: Date
): ResizeRow | null {
  const inFlight = history.find(
    (row) => (row.status === 'PENDING' || row.status === 'RUNNING') && !isStaleRunning(row, now)
  );
  if (inFlight !== undefined) {
    if (sameSize(toSize(inFlight), target)) return inFlight;
    throw new SandboxResizeError(
      409,
      'RESIZE_IN_PROGRESS',
      `A resize to ${sizeLabel(toSize(inFlight))} is already in progress`,
      { request: resizeView(inFlight) }
    );
  }
  const at = (row: ResizeRow) => (row.completedAt ?? row.requestedAt).getTime();
  for (const dim of SIZE_DIMENSIONS.filter((d) => target[d] !== held[d])) {
    const label = DIMENSION_LABEL[dim];
    const last = history.find((row) => row.status === 'DONE' && changes(row, dim));
    if (
      last !== undefined &&
      toSize(last)[dim] === held[dim] &&
      fromSize(last)[dim] === target[dim] &&
      now.getTime() - at(last) < resizeReverseWindowMs()
    ) {
      const retryAfterS = Math.ceil((at(last) + resizeReverseWindowMs() - now.getTime()) / 1000);
      const ago = Math.round((now.getTime() - at(last)) / 60_000);
      throw new SandboxResizeError(
        409,
        'REVERSE_RESIZE',
        `${label} moved from ${target[dim]} to ${held[dim]} ${ago} min ago; moving it straight ` +
          `back is refused for ${Math.ceil(retryAfterS / 60)} more min. ` +
          'If a process is running away, kill or fix it instead.',
        { dimension: dim, retry_after_s: retryAfterS }
      );
    }
    const recent = history.find(
      (row) => (row.status === 'DONE' || row.status === 'FAILED') && changes(row, dim)
    );
    if (recent !== undefined && now.getTime() - at(recent) < resizeCooldownMs()) {
      const retryAfterS = Math.ceil((at(recent) + resizeCooldownMs() - now.getTime()) / 1000);
      throw new SandboxResizeError(
        409,
        'RATE_LIMITED',
        `${label} can change once per ${Math.round(resizeCooldownMs() / 60_000)} min; ` +
          `try again in ${Math.ceil(retryAfterS / 60)} min`,
        { dimension: dim, retry_after_s: retryAfterS }
      );
    }
  }
  return null;
}

export interface ResizeRequestResult {
  httpStatus: 200 | 202;
  body: ResizeRequestView & { message: string };
}

export async function requestSandboxResize(params: {
  userId: string;
  agentId: string;
  taskId: string | null;
  cpu?: number;
  memoryGb?: number;
  reason: string;
  now?: Date;
}): Promise<ResizeRequestResult> {
  const now = params.now ?? new Date();
  const reason = params.reason.trim();
  if (reason === '') {
    throw new SandboxResizeError(400, 'REASON_REQUIRED', 'A reason is required');
  }
  if (params.cpu === undefined && params.memoryGb === undefined) {
    throw new SandboxResizeError(400, 'SIZE_REQUIRED', 'Give --cpu, --memory-gb or both');
  }
  const { task, session } = await resizableSession(params.userId, params.agentId, params.taskId);
  const provider = providerOf(session.codeProvider);
  const held = heldSandboxSize(session);
  const want = { cpu: params.cpu ?? held.cpu, memoryGb: params.memoryGb ?? held.memoryGb };
  const target = closestAvailableSize(provider, want);
  if (target === null) {
    throw new SandboxResizeError(
      409,
      'SIZE_UNAVAILABLE',
      `No ${provider} sandbox with at least ${sizeLabel(want)} is available`,
      { available: availableSizes(provider).map(sizeView) }
    );
  }
  if (sameSize(target, held)) {
    return {
      httpStatus: 200,
      body: {
        request_id: '',
        status: 'unchanged',
        from: sizeView(held),
        to: sizeView(held),
        reason,
        requested_at: now.toISOString(),
        completed_at: null,
        new_task_id: null,
        error: null,
        message: `This session already runs on ${sizeLabel(held)}, the closest size to that request.`,
      },
    };
  }
  const cap = await maxSizeFor(params.userId);
  const over = SIZE_DIMENSIONS.filter((dim) => target[dim] > held[dim] && target[dim] > cap[dim]);
  if (over.length > 0) {
    throw new SandboxResizeError(
      403,
      'SIZE_ABOVE_CAP',
      `${sizeLabel(target)} is above this account's limit (${sizeLabel(cap)})`,
      { max: sizeView(cap), dimensions: over }
    );
  }
  const existing = checkHistory(await resizeHistory(session.id), held, target, now);
  const row =
    existing ??
    (await prisma.codeSessionResize.create({
      data: {
        codeSessionId: session.id,
        userId: params.userId,
        agentId: params.agentId,
        taskId: task.id,
        fromCpu: held.cpu,
        fromMemoryGb: held.memoryGb,
        toCpu: target.cpu,
        toMemoryGb: target.memoryGb,
        reason: reason.slice(0, RESIZE_REASON_MAX),
      },
    }));
  log.info('Sandbox resize requested', {
    codeSessionId: session.id,
    requestId: row.id,
    from: sizeKey(held),
    to: sizeKey(target),
  });
  return {
    httpStatus: 202,
    body: {
      ...resizeView(row),
      message:
        `Resize to ${sizeLabel(target)} accepted (request ${row.id}). Within about two minutes ` +
        'this session is saved and continues in the new sandbox with the same branch, files and ' +
        'conversation; you will get a message when it is ready. Do not start new heavy work until then.',
    },
  };
}

/** Keepalive payload: the session's pending request, for the attached activity to apply. */
export async function pendingResizeForTask(
  codeSessionId: string | null
): Promise<{ request_id: string; from: SizeView; to: SizeView } | null> {
  if (codeSessionId === null) return null;
  const row = await prisma.codeSessionResize.findFirst({
    where: { codeSessionId, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });
  return row === null
    ? null
    : { request_id: row.id, from: sizeView(fromSize(row)), to: sizeView(toSize(row)) };
}

/** What `rose env status` shows about the session's size (the CLI adds live usage). */
export async function environmentStatus(params: {
  userId: string;
  agentId: string;
  taskId: string | null;
}): Promise<Record<string, unknown>> {
  let resolved;
  try {
    resolved = await resizableSession(params.userId, params.agentId, params.taskId);
  } catch (err) {
    if (err instanceof SandboxResizeError && err.code === 'NOT_APPLICABLE') {
      return { applicable: false, message: err.message };
    }
    throw err;
  }
  const { session } = resolved;
  const provider = providerOf(session.codeProvider);
  const history = await resizeHistory(session.id);
  return {
    applicable: true,
    size: sizeView(heldSandboxSize(session)),
    max: sizeView(await maxSizeFor(params.userId)),
    available: availableSizes(provider).map(sizeView),
    cooldown_min: Math.round(resizeCooldownMs() / 60_000),
    resizes: history.slice(0, 5).map(resizeView),
  };
}

// ── applying a request ──

export interface ResizeSessionResult {
  task_id: string;
  sandbox_id: string;
  ws_url: string;
  [field: string]: unknown;
}

export interface ResizeCreateInput {
  agentId: string;
  userId: string;
  goal: string;
  codeSessionId: string;
  leaseOwner: string;
  projectId: string | null;
}

/** The turn the resumed CLI conversation receives after a resize. */
export function resizedTurn(row: ResizeRow): string {
  return [
    `Your environment was resized from ${sizeLabel(fromSize(row))} to ${sizeLabel(toSize(row))}, ` +
      `as you requested ("${row.reason}").`,
    'This is a new sandbox restored from your session: same branch, commits, uncommitted files and conversation.',
    'Processes that were running (dev servers, watchers, builds) were stopped; start again the ones you need.',
    'Continue the task where you left off. Downsize with `rose env size` when the heavy phase is over.',
  ].join('\n');
}

export function resizeFailedTurn(row: ResizeRow, error: string, current: SandboxSize): string {
  return [
    `The resize from ${sizeLabel(fromSize(row))} to ${sizeLabel(toSize(row))} failed (${error.slice(0, 300)}).`,
    `You are on ${sizeLabel(current)}, with your branch, files and conversation as they were.`,
    'Processes that were running were stopped; start again the ones you need, then continue the task.',
  ].join('\n');
}

async function existingResult(row: ResizeRow): Promise<ResizeSessionResult | null> {
  if (row.newTaskId === null) return null;
  const task = await prisma.claudeCodeSession.findUnique({
    where: { id: row.newTaskId },
    select: { id: true, sandboxId: true, streamUrl: true, codeSessionId: true },
  });
  if (task === null || task.streamUrl === null) return null;
  return {
    task_id: task.id,
    sandbox_id: task.sandboxId,
    ws_url: task.streamUrl,
    code_session_id: task.codeSessionId,
  };
}

export interface PerformResizeResult {
  resized: boolean;
  request: ResizeRequestView;
  session: ResizeSessionResult;
}

/**
 * Apply a request for the task's activity. Idempotent per request id: a
 * retry after completion returns the same continuing task; a concurrent one
 * gets 409 RESIZE_IN_PROGRESS and retries.
 */
export async function performSandboxResize(params: {
  taskId: string;
  requestId: string;
  create: (input: ResizeCreateInput) => Promise<ResizeSessionResult>;
  stopCli: (sandboxId: string) => Promise<void>;
  closeTask: (taskId: string) => Promise<void>;
  now?: Date;
}): Promise<PerformResizeResult> {
  const now = params.now ?? new Date();
  const task = await prisma.claudeCodeSession.findUnique({ where: { id: params.taskId } });
  const row = await prisma.codeSessionResize.findUnique({ where: { id: params.requestId } });
  if (task === null || row === null || row.codeSessionId !== task.codeSessionId) {
    throw new SandboxResizeError(404, 'RESIZE_NOT_FOUND', 'Resize request not found');
  }
  const settled = async (current: ResizeRow): Promise<PerformResizeResult | null> => {
    if (current.status !== 'DONE' && current.status !== 'FAILED') return null;
    const session = await existingResult(current);
    if (session === null) {
      throw new SandboxResizeError(409, 'RESIZE_FAILED', current.error ?? 'Resize failed', {
        request: resizeView(current),
      });
    }
    return { resized: current.status === 'DONE', request: resizeView(current), session };
  };
  const done = await settled(row);
  if (done !== null) return done;

  const claimed = await prisma.codeSessionResize.updateMany({
    where: {
      id: row.id,
      OR: [
        { status: 'PENDING' },
        { status: 'RUNNING', startedAt: { lt: new Date(now.getTime() - RESIZE_STALE_MS) } },
      ],
    },
    data: { status: 'RUNNING', startedAt: now },
  });
  if (claimed.count === 0) {
    const current = await prisma.codeSessionResize.findUniqueOrThrow({ where: { id: row.id } });
    const finished = await settled(current);
    if (finished !== null) return finished;
    throw new SandboxResizeError(409, 'RESIZE_IN_PROGRESS', 'This resize is already running', {
      request: resizeView(current),
    });
  }

  const session = await prisma.codeSession.findUniqueOrThrow({ where: { id: row.codeSessionId } });
  const input = {
    agentId: task.agentId,
    userId: row.userId,
    codeSessionId: session.id,
    // The spawn keeps its lease: keepalives and its close still match it.
    leaseOwner: session.leaseOwner ?? `resize:${row.id}`,
    projectId: task.projectId,
  };
  if (task.status !== 'CLOSED') {
    // Stop the old CLI first so nothing changes after the checkpoint.
    await params.stopCli(task.sandboxId).catch((error: unknown) => {
      log.warn('Stopping the CLI before a resize failed', {
        taskId: task.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await params.closeTask(task.id);
  }

  try {
    const created = await params.create({ ...input, goal: resizedTurn(row) });
    const updated = await prisma.codeSessionResize.update({
      where: { id: row.id },
      data: { status: 'DONE', newTaskId: created.task_id, completedAt: new Date() },
    });
    log.info('Sandbox resized', {
      codeSessionId: session.id,
      requestId: row.id,
      from: sizeKey(fromSize(row)),
      to: sizeKey(toSize(row)),
      newTaskId: created.task_id,
    });
    return { resized: true, request: resizeView(updated), session: created };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Sandbox resize failed; continuing on the previous size', {
      codeSessionId: session.id,
      requestId: row.id,
      error: message,
    });
    await prisma.codeSessionResize.update({
      where: { id: row.id },
      data: { status: 'FAILED', error: message.slice(0, 500), completedAt: new Date() },
    });
    const after = await prisma.codeSession.findUniqueOrThrow({ where: { id: session.id } });
    const created = await params.create({
      ...input,
      goal: resizeFailedTurn(row, message, heldSandboxSize(after)),
    });
    const updated = await prisma.codeSessionResize.update({
      where: { id: row.id },
      data: { newTaskId: created.task_id },
    });
    return { resized: false, request: resizeView(updated), session: created };
  }
}

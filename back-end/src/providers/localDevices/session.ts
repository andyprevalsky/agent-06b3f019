/**
 * Local (Mac) code sessions (C14): the same ws-server.mjs the E2B templates run,
 * started by the Rose Mac app inside a folder the user granted and relayed
 * through ./hub.ts. Everything after create (worker agentic loop, transcript,
 * steering, verifier, chip) talks to the relay URL exactly as to a sandbox.
 *
 * Secrets: a local session only ever receives the user's OWN CLI credential.
 * Pool tokens, the funded ANTHROPIC/OPENAI keys, gateway/Fast Mode proxies,
 * GITHUB_TOKEN and BACKEND_API_KEY never leave the backend for a user's Mac.
 */
import { randomUUID } from '../crypto';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { fetchClaudeCodeCredentialsWithMeta } from '../claudeCredentials';
import { fetchGptCodeCredentialsWithMeta } from '../gptCredentials';
import { buildLocalCodeAgentSystemPrompt } from '../codeAgentPrompt';
import {
  claudeCodeSettingsEnvs,
  type CodeAgentSettings,
  codeAgentSettingsForAgent,
  codexCodeSettingsEnvs,
  cliSettingsEnvOverrides,
  type CodeCliSettingsOverride,
} from '../codeAgentModels';
import { compatibleResumeCliSettings, type CodeAgentResumeConfig } from '../codeAgentResumeConfig';
import { persistCodeResumeConfig, resumeLaunchCliSettings } from '../codeAgentResumeConfigStore';
import { isRoseDesktopUser } from '../../utils/roseDesktop';
import {
  LocalSessionStartError,
  localDeviceHub,
  localDeviceSandboxId,
  parseLocalDeviceSandboxId,
  type LocalDeviceHub,
} from './hub';
import {
  LOCAL_TARGET_DEVICE_DISCONNECTED,
  LocalTargetUnavailableError,
  localTargetError,
  type LocalTargetReason,
} from './messages';
import { relayDevicePath, type LocalCodeProvider } from './protocol';
import { findAgentOrigin, findLocalDevice, listLocalDevices } from './store';
import { prepareLocalHome } from './homeFiles';

const log = createLogger('LocalDevices');

export class LocalSessionOwnerMismatchError extends Error {
  constructor() {
    super('The supplied user_id does not own this agent');
    this.name = 'LocalSessionOwnerMismatchError';
  }
}

export type LocalTargetResolution =
  | { available: true; deviceId: string; deviceName: string; userId: string }
  | {
      available: false;
      reason: LocalTargetReason;
      deviceId: string | null;
      deviceName: string | null;
      message: string;
    };

/** Resolve an explicit local request; never substitute another owner's device or cloud. */
export async function resolveLocalTarget(
  agentId: string,
  hub: LocalDeviceHub = localDeviceHub(),
  requestedDeviceId?: string
): Promise<LocalTargetResolution> {
  const unavailable = (reason: LocalTargetReason): LocalTargetResolution => ({
    available: false,
    reason,
    deviceId: null,
    deviceName: null,
    message: localTargetError(reason, null),
  });
  const origin = await findAgentOrigin(agentId);
  if (origin === null) return unavailable('no_owned_device');
  // Preserve the originating Mac when present. An explicit device pins replay;
  // neither a stale nor a foreign selection may silently switch machines.
  const selectedId = requestedDeviceId ?? origin.originDeviceId;
  let device;
  if (selectedId !== null && selectedId !== undefined) {
    device = await findLocalDevice(selectedId);
    if (device === null || device.userId !== origin.userId || device.platform !== 'darwin') {
      return unavailable('no_owned_device');
    }
  } else {
    const devices = (await listLocalDevices(origin.userId)).filter((d) => d.platform === 'darwin');
    if (devices.length === 0) return unavailable('no_owned_device');
    if (devices.length > 1) return unavailable('device_selection_required');
    device = devices[0];
  }
  if (!(await hub.deviceOnline(device.id))) {
    return {
      available: false,
      reason: LOCAL_TARGET_DEVICE_DISCONNECTED,
      deviceId: device.id,
      deviceName: device.name,
      message: localTargetError(LOCAL_TARGET_DEVICE_DISCONNECTED, device.name),
    };
  }
  return { available: true, deviceId: device.id, deviceName: device.name, userId: origin.userId };
}

/** Public base URL relay clients (Fly workers, browsers) use to reach this backend. */
export function localRelayBaseUrl(): string {
  const configured =
    process.env.LOCAL_CODE_RELAY_BASE_URL ??
    process.env.BACKEND_URL ??
    process.env.RENDER_EXTERNAL_URL;
  if (configured !== undefined && configured.trim() !== '') {
    return configured.trim().replace(/\/+$/, '');
  }
  return `http://localhost:${process.env.PORT ?? 3001}`;
}

const PROVIDER_LABEL: Record<LocalCodeProvider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

/** ws-server env for a local session: goal, model, prompt and the user's own login. */
export async function buildLocalSessionEnvs(params: {
  provider: LocalCodeProvider;
  userId: string;
  goal: string;
  deviceName: string;
  /** The spawning agent's tier and speed (codeAgentModels.ts); flash + fast when omitted. */
  settings?: CodeAgentSettings;
}): Promise<{
  envs: Record<string, string>;
  claudeTokenSource: string | null;
  /** The user's own integration row, so a usage limit marks exactly it (C15). */
  integrationId: string | null;
}> {
  // The Mac sets ROSE_LOCAL_WORKDIR to the granted folder (the CLI's cwd).
  // The session HOME gets the same account-group skills (homeFiles → prepareCodeSessionWorkspace).
  const systemPrompt = buildLocalCodeAgentSystemPrompt({
    roseDesktop: isRoseDesktopUser(params.userId),
  });
  const noCredentials = (): LocalTargetUnavailableError =>
    new LocalTargetUnavailableError(
      'no_own_credentials',
      params.deviceName,
      localTargetError('no_own_credentials', params.deviceName, PROVIDER_LABEL[params.provider])
    );
  if (params.provider === 'codex') {
    const credential = await fetchGptCodeCredentialsWithMeta(params.userId);
    if (credential === null || credential.source !== 'user') throw noCredentials();
    return {
      envs: {
        CODEX_GOAL: params.goal,
        ...codexCodeSettingsEnvs(params.settings ?? { tier: 'flash', speed: 'fast' }),
        CODEX_AUTH_JSON: credential.credentials,
        CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
        CODE_AGENT_HARNESS_MODE: 'code',
      },
      claudeTokenSource: 'user',
      integrationId: credential.integrationId ?? null,
    };
  }
  const credential = await fetchClaudeCodeCredentialsWithMeta(params.userId);
  if (credential === null || credential.source !== 'user') throw noCredentials();
  const envs: Record<string, string> = {
    CLAUDE_CODE_GOAL: params.goal,
    ...claudeCodeSettingsEnvs(params.settings ?? { tier: 'flash', speed: 'fast' }),
    CODE_AGENT_SYSTEM_PROMPT: systemPrompt,
  };
  if (credential.credentials !== undefined) envs.CLAUDE_CODE_CREDENTIALS = credential.credentials;
  if (credential.accessToken !== undefined) envs.CLAUDE_CODE_OAUTH_TOKEN = credential.accessToken;
  // The own login it runs on, so a usage limit marks exactly that account.
  return { envs, claudeTokenSource: 'user', integrationId: credential.integrationId ?? null };
}

function startErrorToTarget(error: LocalSessionStartError, deviceName: string): Error {
  if (error.code === 'device_disconnected') {
    return new LocalTargetUnavailableError(LOCAL_TARGET_DEVICE_DISCONNECTED, deviceName);
  }
  if (error.code === 'no_folder_granted' || error.code === 'folder_not_granted') {
    return new LocalTargetUnavailableError('no_folder_granted', deviceName);
  }
  return new Error(`Local code session on ${deviceName} failed to start: ${error.message}`);
}

export interface LocalDeviceSessionResult {
  wsUrl: string;
  taskId: string;
  sandboxId: string;
  uploadedFiles: string[];
  deviceId: string;
  deviceName: string;
  folder: string;
}

/**
 * Start a code session on the agent tree's Mac. Throws LocalTargetUnavailableError
 * (exact user-facing text) when the Mac cannot run it now.
 */
export async function createLocalDeviceCodeSession(
  params: {
    agentId: string;
    goal: string;
    provider: LocalCodeProvider;
    /** Absolute folder the agent asked for; null = the Mac's default grant. */
    folder?: string | null;
    /** Caller-asserted owner; must match the agent's owner. */
    expectedUserId?: string;
    deviceId?: string;
    /** The spawn's task_name, stored on the task row (the agents list title). */
    taskName?: string | null;
    cliSettings?: CodeCliSettingsOverride;
    resumeConfig?: CodeAgentResumeConfig;
    leaseOwner?: string;
  },
  hub: LocalDeviceHub = localDeviceHub()
): Promise<LocalDeviceSessionResult> {
  const target = await resolveLocalTarget(params.agentId, hub, params.deviceId);
  if (
    target.available &&
    params.expectedUserId !== undefined &&
    target.userId !== params.expectedUserId
  ) {
    throw new LocalSessionOwnerMismatchError();
  }
  if (!target.available) {
    throw new LocalTargetUnavailableError(target.reason, target.deviceName, target.message);
  }
  const { envs, claudeTokenSource, integrationId } = await buildLocalSessionEnvs({
    provider: params.provider,
    userId: target.userId,
    goal: params.goal,
    deviceName: target.deviceName,
    settings: await codeAgentSettingsForAgent(params.agentId),
  });
  const taskId = randomUUID();
  Object.assign(
    envs,
    cliSettingsEnvOverrides(
      params.provider,
      await resumeLaunchCliSettings(
        params.agentId,
        params.provider,
        params.leaseOwner,
        compatibleResumeCliSettings(
          params.provider,
          params.resumeConfig?.source_code_provider,
          params.cliSettings
        )
      )
    )
  );
  await persistCodeResumeConfig({
    agentId: params.agentId,
    taskId,
    provider: params.provider,
    envs,
    resumeConfig: params.resumeConfig,
    leaseOwner: params.leaseOwner,
    execution: { github_repo_link: null, target: 'local', code_session_id: null },
  });
  const sandboxId = localDeviceSandboxId(target.deviceId, taskId);
  log.info(`Starting local ${params.provider} session on ${target.deviceName}`, {
    agent_id: params.agentId,
    task_id: taskId,
    device_id: target.deviceId,
  });
  // Same in-session Rose tools as a sandbox (rose / rose-agents / rose-ui + MCP).
  const home = await prepareLocalHome({
    userId: target.userId,
    agentId: params.agentId,
    taskId,
    provider: params.provider,
    homeDir: await hub.sessionHome(target.deviceId, taskId),
  });
  let folder: string;
  try {
    ({ folder } = await hub.startSession({
      deviceId: target.deviceId,
      userId: target.userId,
      command: {
        type: 'start_session',
        task_id: taskId,
        agent_id: params.agentId,
        provider: params.provider,
        folder: params.folder ?? null,
        envs: { ...home.envs, ...envs },
        relay_path: relayDevicePath(taskId),
        home_files: home.files,
      },
    }));
  } catch (error) {
    if (error instanceof LocalSessionStartError) throw startErrorToTarget(error, target.deviceName);
    throw error;
  }
  const wsUrl = hub.relayClientUrl(taskId, localRelayBaseUrl());
  try {
    await prisma.claudeCodeSession.create({
      data: {
        id: taskId,
        agentId: params.agentId,
        sandboxId,
        streamUrl: wsUrl,
        goal: params.goal,
        taskName: params.taskName ?? null,
        status: 'ACTIVE',
        claudeTokenSource,
        claudeTokenIntegrationId: integrationId,
        // Per-task provider: the agent tree lists it (W5 code_agents[].provider).
        codeProvider: params.provider,
      },
    });
  } catch (error) {
    // Best-effort: a failed stop must not replace the original error.
    await hub.stopSession(taskId, target.deviceId).catch((stopError: unknown) =>
      log.warn('Local session stop after a failed create failed', {
        task_id: taskId,
        error: stopError instanceof Error ? stopError.message : String(stopError),
      })
    );
    throw error;
  }
  return {
    wsUrl,
    taskId,
    sandboxId,
    uploadedFiles: [],
    deviceId: target.deviceId,
    deviceName: target.deviceName,
    folder,
  };
}

/** The code-session create response for a local session (same shape as E2B's). */
export async function createLocalCodeSessionResponse(params: {
  agentId: string;
  goal: string;
  provider: LocalCodeProvider;
  expectedUserId?: string;
  deviceId?: string;
  taskName?: string | null;
  cliSettings?: CodeCliSettingsOverride;
  resumeConfig?: CodeAgentResumeConfig;
  leaseOwner?: string;
}): Promise<{
  task_id: string;
  sandbox_id: string;
  ws_url: string;
  uploaded_files: string[];
  github_repo_url: null;
  device_name: string;
  /** Display path of the granted folder on the Mac (e.g. "~/Developer/rose"). */
  folder: string;
}> {
  // No clone, attachments or funded credentials on a user's Mac: the work
  // happens in the folder they granted, with their own CLI login.
  const local = await createLocalDeviceCodeSession(params);
  return {
    task_id: local.taskId,
    sandbox_id: local.sandboxId,
    ws_url: local.wsUrl,
    uploaded_files: [],
    github_repo_url: null,
    device_name: local.deviceName,
    folder: local.folder,
  };
}

/**
 * Close a local session: stop it on the Mac (if connected) and mark it CLOSED.
 * Work stays in the user's folder; nothing is uploaded from their disk.
 */
export async function closeLocalDeviceCodeSession(
  taskId: string,
  sandboxId: string,
  hub: LocalDeviceHub = localDeviceHub(),
  options?: { propagateStopFailure?: boolean }
): Promise<{ outputFiles: [] }> {
  // Best-effort: the session row is marked CLOSED even when the Mac is unreachable.
  await hub
    .stopSession(taskId, parseLocalDeviceSandboxId(sandboxId)?.deviceId ?? null)
    .catch((error: unknown) => {
      if (options?.propagateStopFailure) throw error;
      log.warn('Local session stop failed; marking it closed', {
        task_id: taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  await prisma.claudeCodeSession.updateMany({
    where: { id: taskId, status: 'ACTIVE' },
    data: { status: 'CLOSED', closedAt: new Date() },
  });
  return { outputFiles: [] };
}

export async function localDeviceSessionHealth(
  sandboxId: string,
  hub: LocalDeviceHub = localDeviceHub()
): Promise<{ alive: boolean; sandbox_id: string; error?: string }> {
  const owner = parseLocalDeviceSandboxId(sandboxId);
  if (owner === null) return { alive: false, sandbox_id: sandboxId, error: 'not a local session' };
  const alive = await hub.sessionLive(owner.deviceId, owner.taskId);
  return alive
    ? { alive, sandbox_id: sandboxId }
    : { alive, sandbox_id: sandboxId, error: 'The Rose Mac app is not connected' };
}

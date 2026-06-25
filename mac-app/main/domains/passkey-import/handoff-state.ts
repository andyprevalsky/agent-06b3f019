/**
 * Credential Exchange handoff state preparation.
 *
 * State machine:
 *   [SYNC_CLICK] -> clear stale Rose activity file
 *     -> restart macOS handoff/auth/cache agents
 *     -> unregister stale Rose LaunchServices records
 *     -> register installed Rose.app with LaunchServices
 *     -> register/enable PasskeyProvider with PluginKit
 *     -> verify PluginKit points at /Applications/Rose.app
 *     -> verify LaunchServices routes ASCredentialExchangeActivity to /Applications/Rose.app
 *     -> [PASSWORDS_APP_CAN_EXPORT_TO_CURRENT_ROSE]
 *
 * System context:
 *   Passkeys modal Sync -> system:openPasswordsApp -> this module
 *     -> macOS Passwords export destination cache -> ASCredentialExchangeActivity
 *     -> Rose native bridge -> import helper -> backend upload.
 */

import { execFile, spawn } from 'child_process';
import { dirname, join, resolve } from 'path';
import { rm } from 'fs/promises';
import { app } from 'electron';
import { toError } from '../../../shared/utils/error';

const INSTALLED_APP_PATH = '/Applications/Rose.app';
const PASSKEY_PROVIDER_BUNDLE_ID = 'com.rose.desktop.PasskeyProvider';
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const LSREGISTER_RECORD_SEPARATOR =
  '\n--------------------------------------------------------------------------------\n';
const MAX_LAUNCHSERVICES_RECORD_BYTES = 4 * 1024 * 1024;
const LAUNCHSERVICES_VERIFY_RETRY_DELAYS_MS =
  process.env.NODE_ENV === 'test' ? [1, 1] : [250, 750, 1500, 3000];
const PROCESS_RESTART_TERM_WAIT_MS = process.env.NODE_ENV === 'test' ? 1 : 750;
const PROCESS_RESTART_KILL_WAIT_MS = process.env.NODE_ENV === 'test' ? 1 : 2000;

const RESTARTABLE_HANDOFF_PROCESS_SPECS = [
  { label: 'Passwords', pattern: 'Passwords.app/Contents/MacOS/Passwords' },
  { label: 'AuthenticationServicesAgent', pattern: 'AuthenticationServicesAgent' },
  {
    label: 'com.apple.AuthenticationServices.Helper',
    pattern: 'com.apple.AuthenticationServices.Helper',
  },
  { label: 'useractivityd', pattern: 'useractivityd' },
  { label: 'sharingd', pattern: 'sharingd' },
  { label: 'ScopedBookmarkAgent', pattern: 'ScopedBookmarkAgent' },
  { label: 'swcd', pattern: 'swcd' },
  { label: 'cfprefsd', pattern: 'cfprefsd' },
  { label: 'lsd', pattern: '/usr/libexec/lsd' },
];
const RESTARTABLE_HANDOFF_PROCESSES = RESTARTABLE_HANDOFF_PROCESS_SPECS.map((spec) => spec.label);

interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface CredentialExchangeHandoffPreparation {
  activityPath: string;
  appPath: string;
  pluginPath: string;
  restartedProcesses: string[];
  staleLaunchServicesRecords: string[];
  credentialExchangeLaunchServicesRecords: string[];
}

interface RoseLaunchServicesRecord {
  identifier: string | null;
  path: string | null;
  activityTypes: string;
  claimsCredentialExchange: boolean;
  installed: boolean;
}

interface RoseLaunchServicesScan {
  stalePaths: string[];
  records: RoseLaunchServicesRecord[];
}

function execFileChecked(command: string, args: string[], timeout = 5000): Promise<ExecResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

async function execFileSoft(command: string, args: string[], timeout = 3000): Promise<boolean> {
  try {
    await execFileChecked(command, args, timeout);
    return true;
  } catch {
    return false;
  }
}

function installedRoseAppPath(): string {
  if (app.isPackaged) {
    const bundlePath = resolve(dirname(process.execPath), '..', '..');
    if (bundlePath.endsWith('.app')) {
      return bundlePath;
    }
  }
  return INSTALLED_APP_PATH;
}

function credentialExchangeActivityPath(): string {
  return join(app.getPath('userData'), 'credential-exchange-activity.json');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function extractLaunchServicesPath(record: string): string | null {
  const pathMatch = record.match(/^path:\s+(.+?)\s+\(0x[0-9a-f]+\)\s*$/m);
  return pathMatch === null ? null : pathMatch[1];
}

function extractLaunchServicesIdentifier(record: string): string | null {
  const identifier = record.match(/^identifier:\s+([^\s]+)\s*$/m);
  return identifier === null ? null : identifier[1];
}

function extractLaunchServicesActivityTypes(record: string): string {
  const activityTypes = record.match(/^activityTypes:\s+(.+?)\s*$/m);
  return activityTypes === null ? '' : activityTypes[1];
}

function isInstalledRosePath(recordPath: string, installedAppPath: string): boolean {
  return recordPath === installedAppPath || recordPath.startsWith(`${installedAppPath}/`);
}

function parseRoseLaunchServicesRecord(
  record: string,
  installedAppPath: string
): RoseLaunchServicesRecord | null {
  const identifier = extractLaunchServicesIdentifier(record);
  const recordPath = extractLaunchServicesPath(record);
  const activityTypes = extractLaunchServicesActivityTypes(record);
  const mentionsRose =
    record.includes('com.rose.desktop') ||
    recordPath?.includes('/Rose.app') === true ||
    recordPath?.includes('/PasskeyProvider.appex') === true;

  if (!mentionsRose) {
    return null;
  }

  return {
    identifier,
    path: recordPath,
    activityTypes,
    claimsCredentialExchange: activityTypes.includes('ASCredentialExchangeActivity'),
    installed: recordPath !== null && isInstalledRosePath(recordPath, installedAppPath),
  };
}

function scanRoseLaunchServicesDump(
  dump: string,
  installedAppPath: string
): RoseLaunchServicesScan {
  const records = dump.split(LSREGISTER_RECORD_SEPARATOR);
  const scan: RoseLaunchServicesScan = { stalePaths: [], records: [] };
  const stalePaths = new Set<string>();
  for (const record of records) {
    const parsed = parseRoseLaunchServicesRecord(record, installedAppPath);
    if (parsed === null) {
      continue;
    }
    scan.records.push(parsed);
    if (parsed.path !== null && !parsed.installed) {
      stalePaths.add(parsed.path);
    }
  }
  scan.stalePaths = Array.from(stalePaths);
  return scan;
}

function extractStaleRoseLaunchServicesRecords(dump: string, installedAppPath: string): string[] {
  return scanRoseLaunchServicesDump(dump, installedAppPath).stalePaths;
}

function appendBounded(previous: string, next: string, maxLength: number): string {
  const combined = previous + next;
  if (combined.length <= maxLength) {
    return combined;
  }
  return combined.slice(combined.length - maxLength);
}

function formatRoseLaunchServicesRecord(record: RoseLaunchServicesRecord): string {
  const activityTypes = record.activityTypes === '' ? 'none' : record.activityTypes;
  return `${record.identifier ?? 'unknown'} @ ${record.path ?? 'unknown'} activities=${activityTypes}`;
}

async function streamRoseLaunchServicesState(appPath: string): Promise<RoseLaunchServicesScan> {
  return new Promise((resolvePromise, reject) => {
    const stalePaths = new Set<string>();
    const records: RoseLaunchServicesRecord[] = [];
    const child = spawn(LSREGISTER, ['-dump'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      fail(new Error('Timed out while scanning LaunchServices Rose registrations'));
      child.kill('SIGKILL');
    }, 10000);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      reject(error);
    }

    function collectRecord(record: string): void {
      const parsed = parseRoseLaunchServicesRecord(record, appPath);
      if (parsed === null) {
        return;
      }
      records.push(parsed);
      if (parsed.path !== null && !parsed.installed) {
        stalePaths.add(parsed.path);
      }
    }

    function consumeCompleteRecords(): void {
      let separatorIndex = stdoutBuffer.indexOf(LSREGISTER_RECORD_SEPARATOR);
      while (separatorIndex !== -1) {
        collectRecord(stdoutBuffer.slice(0, separatorIndex));
        stdoutBuffer = stdoutBuffer.slice(separatorIndex + LSREGISTER_RECORD_SEPARATOR.length);
        separatorIndex = stdoutBuffer.indexOf(LSREGISTER_RECORD_SEPARATOR);
      }

      if (stdoutBuffer.length > MAX_LAUNCHSERVICES_RECORD_BYTES) {
        fail(
          new Error(
            `LaunchServices record exceeded ${MAX_LAUNCHSERVICES_RECORD_BYTES} bytes while scanning Rose registrations`
          )
        );
        child.kill('SIGKILL');
      }
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string | Buffer) => {
      if (settled) return;
      stdoutBuffer += chunk.toString();
      consumeCompleteRecords();
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string | Buffer) => {
      stderrBuffer = appendBounded(stderrBuffer, chunk.toString(), 8192);
    });

    child.on('error', fail);
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const stderr = stderrBuffer.trim();
        const detail = stderr !== '' ? `: ${stderr}` : '';
        fail(new Error(`lsregister -dump exited ${code ?? signal}${detail}`));
        return;
      }

      if (stdoutBuffer.trim() !== '') {
        collectRecord(stdoutBuffer);
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolvePromise({ stalePaths: Array.from(stalePaths), records });
    });
  });
}

async function unregisterStaleRoseLaunchServicesRecords(appPath: string): Promise<string[]> {
  const { stalePaths } = await streamRoseLaunchServicesState(appPath);
  for (const stalePath of stalePaths) {
    await execFileSoft(LSREGISTER, ['-u', stalePath], 5000);
  }
  return stalePaths;
}

async function restartHandoffProcesses(): Promise<string[]> {
  const restarted: string[] = [];
  for (const spec of RESTARTABLE_HANDOFF_PROCESS_SPECS) {
    const initialPids = await findProcessIds(spec.pattern);
    if (initialPids.length === 0) {
      continue;
    }

    await signalProcessIds('TERM', initialPids);
    let remainingPids = await waitForOriginalPidsToExit(
      spec.pattern,
      initialPids,
      PROCESS_RESTART_TERM_WAIT_MS
    );

    if (remainingPids.length > 0) {
      await signalProcessIds('KILL', remainingPids);
      remainingPids = await waitForOriginalPidsToExit(
        spec.pattern,
        remainingPids,
        PROCESS_RESTART_KILL_WAIT_MS
      );
    }

    if (remainingPids.length > 0) {
      throw new Error(
        `Could not restart ${spec.label}; PIDs still alive after SIGKILL: ${remainingPids.join(
          ', '
        )}`
      );
    }

    restarted.push(spec.label);
  }
  return restarted;
}

async function findProcessIds(pattern: string): Promise<number[]> {
  const user = process.env.USER;
  const args = user !== undefined && user !== '' ? ['-u', user, '-f', pattern] : ['-f', pattern];
  try {
    const { stdout } = await execFileChecked('pgrep', args, 3000);
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function signalProcessIds(signal: 'TERM' | 'KILL', pids: number[]): Promise<void> {
  if (pids.length === 0) {
    return;
  }
  await execFileSoft('/bin/kill', [`-${signal}`, ...pids.map(String)], 3000);
}

async function waitForOriginalPidsToExit(
  pattern: string,
  originalPids: number[],
  waitMs: number
): Promise<number[]> {
  await sleep(waitMs);
  const livePids = new Set(await findProcessIds(pattern));
  return originalPids.filter((pid) => livePids.has(pid));
}

async function registerLaunchServicesAndPluginKit(
  appPath: string,
  pluginPath: string
): Promise<void> {
  await execFileChecked(LSREGISTER, ['-f', appPath], 10000);
  await execFileChecked('pluginkit', ['-a', pluginPath], 10000);
  await execFileChecked('pluginkit', ['-e', 'use', '-i', PASSKEY_PROVIDER_BUNDLE_ID], 10000);

  const { stdout } = await execFileChecked(
    'pluginkit',
    ['-m', '-A', '-v', '-i', PASSKEY_PROVIDER_BUNDLE_ID],
    10000
  );
  if (!stdout.includes(pluginPath)) {
    throw new Error(`PluginKit did not register ${PASSKEY_PROVIDER_BUNDLE_ID} at ${pluginPath}`);
  }
}

function assertLaunchServicesCredentialExchangeReady(
  scan: RoseLaunchServicesScan,
  appPath: string
): RoseLaunchServicesRecord[] {
  if (scan.stalePaths.length > 0) {
    throw new Error(`Stale Rose LaunchServices records remain: ${scan.stalePaths.join(', ')}`);
  }

  const installedCredentialExchangeRecord = scan.records.find(
    (record) =>
      record.identifier === 'com.rose.desktop' &&
      record.path === appPath &&
      record.claimsCredentialExchange
  );

  if (installedCredentialExchangeRecord === undefined) {
    const summaries =
      scan.records.length === 0
        ? 'none'
        : scan.records.map(formatRoseLaunchServicesRecord).join(' | ');
    throw new Error(
      `LaunchServices is not routing ASCredentialExchangeActivity to ${appPath}. Rose records: ${summaries}`
    );
  }

  return scan.records.filter((record) => record.claimsCredentialExchange);
}

async function verifyLaunchServicesCredentialExchangeRegistration(
  appPath: string
): Promise<string[]> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= LAUNCHSERVICES_VERIFY_RETRY_DELAYS_MS.length; attempt += 1) {
    const scan = await streamRoseLaunchServicesState(appPath);

    if (scan.stalePaths.length > 0) {
      for (const stalePath of scan.stalePaths) {
        await execFileSoft(LSREGISTER, ['-u', stalePath], 5000);
      }
    }

    try {
      return assertLaunchServicesCredentialExchangeReady(scan, appPath).map(
        formatRoseLaunchServicesRecord
      );
    } catch (error) {
      lastError = toError(error);
      const delayMs = LAUNCHSERVICES_VERIFY_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        break;
      }
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('LaunchServices credential exchange verification failed');
}

export async function prepareCredentialExchangeHandoff(): Promise<CredentialExchangeHandoffPreparation> {
  const appPath = installedRoseAppPath();
  const pluginPath = join(appPath, 'Contents', 'PlugIns', 'PasskeyProvider.appex');
  const activityPath = credentialExchangeActivityPath();

  await rm(activityPath, { force: true });
  const restartedProcesses = await restartHandoffProcesses();
  const staleLaunchServicesRecords = await unregisterStaleRoseLaunchServicesRecords(appPath);
  await registerLaunchServicesAndPluginKit(appPath, pluginPath);
  const credentialExchangeLaunchServicesRecords =
    await verifyLaunchServicesCredentialExchangeRegistration(appPath);

  return {
    activityPath,
    appPath,
    pluginPath,
    restartedProcesses,
    staleLaunchServicesRecords,
    credentialExchangeLaunchServicesRecords,
  };
}

export const __passkeyHandoffStateTest = {
  extractStaleRoseLaunchServicesRecords,
  scanRoseLaunchServicesDump,
  LSREGISTER_RECORD_SEPARATOR,
  RESTARTABLE_HANDOFF_PROCESSES,
  RESTARTABLE_HANDOFF_PROCESS_SPECS,
};

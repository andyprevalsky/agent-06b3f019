/**
 * Passkey permission service.
 *
 * State machine:
 *   request -> ensure CredentialExchangeEnabled developer gate
 *     -> spawn rose-passkey-permission
 *     -> { success, enabled } JSON -> return to IPC
 *     -> helper error/bad JSON -> { success:false, message }
 *
 * System context:
 *   renderer Sync Passkeys -> IPC system:openAutoFillSettings -> native
 *   ASSettingsHelper prompt/settings -> renderer updates modal + row state.
 */

import { execFile, spawn } from 'child_process';
import { join } from 'path';
import { app } from 'electron';
import { getErrorMessage } from '../../../shared/utils/error';

export interface AutoFillSettingsResult {
  success: boolean;
  enabled?: boolean;
  credentialExchangeEnabled?: boolean;
  openedSettings?: boolean;
  message?: string;
}

const CREDENTIAL_EXCHANGE_DEFAULTS_DOMAIN = 'com.apple.AuthenticationServices.Developer';
const CREDENTIAL_EXCHANGE_DEFAULTS_KEY = 'CredentialExchangeEnabled';

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'native', 'rose-passkey-permission')
    : join(app.getAppPath(), 'dist', 'native', 'rose-passkey-permission');
}

export function parsePluginKitProviderEnabled(output: string, bundleId: string): boolean {
  return output.split('\n').some((line) => line.trim().startsWith(`+    ${bundleId}(`));
}

export function parseCredentialExchangeEnabledDefault(output: string): boolean {
  const value = output.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function execFileQuiet(
  command: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function readCredentialExchangeDeveloperFlag(): Promise<boolean> {
  try {
    const { stdout } = await execFileQuiet('defaults', [
      'read',
      CREDENTIAL_EXCHANGE_DEFAULTS_DOMAIN,
      CREDENTIAL_EXCHANGE_DEFAULTS_KEY,
    ]);
    return parseCredentialExchangeEnabledDefault(stdout);
  } catch {
    return false;
  }
}

async function ensureCredentialExchangeDeveloperFlag(): Promise<boolean> {
  if (await readCredentialExchangeDeveloperFlag()) {
    return true;
  }

  await execFileQuiet('defaults', [
    'write',
    CREDENTIAL_EXCHANGE_DEFAULTS_DOMAIN,
    CREDENTIAL_EXCHANGE_DEFAULTS_KEY,
    '-bool',
    'YES',
  ]);

  // AuthenticationServicesAgent caches this developer gate. Restarting it is
  // needed before Passwords evaluates export destinations.
  await execFileQuiet('killall', ['AuthenticationServicesAgent']).catch(() => undefined);
  return readCredentialExchangeDeveloperFlag();
}

export function isRoseProviderEnabled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'pluginkit',
      ['-m', '-A', '-p', 'com.apple.authentication-services-credential-provider-ui'],
      { timeout: 2000 },
      (_error, stdout) => {
        resolve(parsePluginKitProviderEnabled(stdout, 'com.rose.desktop.PasskeyProvider'));
      }
    );
  });
}

function requestAutoFillPermissionWithHelper(): Promise<AutoFillSettingsResult> {
  return new Promise((resolve) => {
    const child = spawn(helperPath(), [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    child.on('error', (error) => {
      resolve({ success: false, message: error.message });
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        resolve({
          success: false,
          message:
            err.trim() ||
            `rose-passkey-permission exited code=${code ?? 'null'} signal=${signal ?? 'null'}`,
        });
        return;
      }

      try {
        const result = JSON.parse(out) as AutoFillSettingsResult;
        if (result.success && result.enabled !== true) {
          void isRoseProviderEnabled().then((enabled) => {
            resolve(enabled ? { ...result, enabled: true } : result);
          });
          return;
        }
        resolve(result);
      } catch {
        resolve({ success: false, message: `Invalid permission helper output: ${out}` });
      }
    });
  });
}

export async function getPasskeyAutoFillStatus(): Promise<AutoFillSettingsResult> {
  const credentialExchangeEnabled = await readCredentialExchangeDeveloperFlag();
  const enabled = await isRoseProviderEnabled();
  return {
    success: true,
    enabled,
    credentialExchangeEnabled,
  };
}

export async function requestPasskeyAutoFillPermission(): Promise<AutoFillSettingsResult> {
  try {
    const credentialExchangeEnabled = await ensureCredentialExchangeDeveloperFlag();
    const result = await requestAutoFillPermissionWithHelper();
    return { ...result, credentialExchangeEnabled };
  } catch (error) {
    return {
      success: false,
      credentialExchangeEnabled: false,
      message: getErrorMessage(error),
    };
  }
}

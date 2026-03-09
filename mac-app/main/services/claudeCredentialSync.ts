import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync, spawn } from 'child_process';
import { BrowserWindow } from 'electron';
import { Crypto } from '../base/crypto';
import { AuthService } from './auth';
import { IntegrationCache } from './sync/IntegrationCache';
import { config } from '../base/config';
import { logConsole, logConsoleError } from '../base/logger';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// RSA-2048 Public Key for Claude credential encryption
// The corresponding private key is stored as CLAUDE_CREDENTIAL_DECRYPTION_KEY on the backend
const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyb0JJxUJ5Xb/agJKydem
vW7TwQiSMb2JWxNhErFx6BmKrLV/ISXVV/upVnb+P81ALRBNEvbtT+E20URnAv3H
nOjaHB/ZZRccfn6G9sQ/TtGcj/BD/PAOtmAC19CsZeHBCwExxuGnHh6K2mcUK40B
55jYGV0oJF8njalwEAUwWWu6H5Trs2OwvN06D+SrycccmMaAMkKQxgPsQEE+9bIT
uU2H4vZYBbnfXJJJw7pCCA7Tu1SfkFh8R+cp+gBL3G9xQPFtukwM2qFrpLBZP/qt
se+GalFwrA45LYFLKaLMdAUOy6Z+6Td/5sbhAT/3LPFnll1cSRwh8MlF/xeskYsr
kwIDAQAB
-----END PUBLIC KEY-----`;

export class ClaudeCredentialSync {
  private static _mockNoClaudeCode = false;

  static setMockNoClaudeCode(mock: boolean) {
    this._mockNoClaudeCode = mock;
    logConsole('ClaudeCredentialSync', `Mock no Claude Code: ${mock}`);
  }

  /**
   * Build env with augmented PATH for finding npm/claude in packaged Electron apps.
   */
  private static getAugmentedEnv(): NodeJS.ProcessEnv {
    const home = process.env.HOME || '';
    const extraPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.npm-global/bin`,
    ];

    // Include ALL NVM node version bin dirs (packaged Electron won't have NVM_DIR set)
    try {
      const nvmDir = process.env.NVM_DIR || `${home}/.nvm`;
      const versionsDir = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(versionsDir)) {
        const versions = fs.readdirSync(versionsDir);
        for (const v of versions) {
          const binDir = path.join(versionsDir, v, 'bin');
          if (fs.existsSync(binDir)) {
            extraPaths.push(binDir);
          }
        }
      }
    } catch {
      // NVM not installed, skip
    }

    // Also try the user's default shell PATH as a last resort
    try {
      const shellPath = execSync('/bin/bash -ilc "echo $PATH"', { stdio: 'pipe', encoding: 'utf8', timeout: 3000 }).trim();
      if (shellPath) {
        extraPaths.push(...shellPath.split(':'));
      }
    } catch {
      // Ignore
    }

    const PATH = [...extraPaths, process.env.PATH].filter(Boolean).join(':');
    return { ...process.env, PATH };
  }

  /**
   * Find the npm-installed claude binary path.
   * Prefers npm global install over any bundled/app-local claude.
   */
  private static findNpmClaudePath(): string | null {
    const env = this.getAugmentedEnv();
    try {
      // Get npm global bin directory
      const npmBin = execSync('npm config get prefix', { stdio: 'pipe', encoding: 'utf8', env }).trim();
      const claudePath = path.join(npmBin, 'bin', 'claude');
      if (fs.existsSync(claudePath)) {
        return claudePath;
      }
    } catch {
      // npm not available
    }
    return null;
  }

  /**
   * Check if Claude Code is installed via npm (not a bundled copy).
   */
  private static isClaudeInstalled(): boolean {
    if (this._mockNoClaudeCode) return false;
    return this.findNpmClaudePath() !== null;
  }

  /**
   * Get the full path to the npm-installed `claude` binary.
   */
  private static getClaudePath(): string {
    return this.findNpmClaudePath() || 'claude';
  }

  /**
   * Install Claude Code CLI via npm.
   */
  private static installClaudeCLI(onStatus: (status: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      onStatus('Installing Claude Code...');
      logConsole('ClaudeCredentialSync', 'Installing Claude Code via npm');

      const env = this.getAugmentedEnv();
      let npmPath: string;
      try {
        npmPath = execSync('which npm', { stdio: 'pipe', encoding: 'utf8', env }).trim();
      } catch {
        reject(new Error('npm not found. Please install Node.js from https://nodejs.org and try again.'));
        return;
      }

      const proc = spawn(npmPath, ['install', '-g', '@anthropic-ai/claude-code'], {
        env,
        stdio: 'pipe',
      });

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdout.on('data', (d) => {
        logConsole('ClaudeCredentialSync', `npm install stdout: ${d.toString().trim()}`);
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Claude Code installation timed out after 2 minutes'));
      }, 120_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          logConsole('ClaudeCredentialSync', 'Claude Code installed successfully');
          resolve();
        } else {
          reject(new Error(`npm install failed (exit ${code}): ${stderr.slice(0, 200)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Run `claude setup-token` to create a long-lived OAuth token (1 year).
   * Parses the token from stdout and writes it to the macOS Keychain.
   */
  private static runClaudeSetupToken(onStatus: (status: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const claudePath = this.getClaudePath();
      const env = this.getAugmentedEnv();

      // In mock mode, logout first to force a fresh OAuth flow
      if (this._mockNoClaudeCode) {
        try {
          logConsole('ClaudeCredentialSync', 'MOCK: Running claude auth logout first');
          execFileSync(claudePath, ['auth', 'logout'], { stdio: 'pipe', env });
        } catch {
          // Ignore logout errors
        }
      }

      onStatus('Opening browser for authentication...');
      logConsole('ClaudeCredentialSync', `Running: ${claudePath} setup-token`);

      const proc = spawn(claudePath, ['setup-token'], {
        env,
        stdio: 'pipe',
      });

      let stdout = '';
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdout += chunk;
        const line = chunk.trim();
        if (line) logConsole('ClaudeCredentialSync', `setup-token: ${line}`);
      });

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Authentication timed out after 5 minutes. Please try again.'));
      }, 300_000);

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude setup-token failed (exit ${code}): ${stderr.slice(0, 200)}`));
          return;
        }

        // Parse the long-lived token from stdout
        const tokenMatch = stdout.match(/(sk-ant-oat[A-Za-z0-9_-]+)/);
        if (!tokenMatch) {
          reject(new Error('Could not parse token from claude setup-token output'));
          return;
        }

        const accessToken = tokenMatch[1];
        logConsole('ClaudeCredentialSync', `Parsed long-lived token (${accessToken.length} chars)`);

        // Build credential JSON and write to Keychain
        const credentials = JSON.stringify({
          claudeAiOauth: {
            accessToken,
            expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
          },
        });

        try {
          // Remove old entry if it exists
          try {
            execFileSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE], { stdio: 'pipe' });
          } catch {
            // No existing entry, that's fine
          }

          // Write new credentials to Keychain (use execFileSync to avoid shell injection)
          const username = process.env.USER || 'unknown';
          execFileSync('security', ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', username, '-w', credentials], { stdio: 'pipe' });
          logConsole('ClaudeCredentialSync', 'Long-lived token written to Keychain');
          resolve();
        } catch (err) {
          reject(new Error(`Failed to write credentials to Keychain: ${err instanceof Error ? err.message : String(err)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Check if Claude Code credentials exist in the macOS Keychain.
   */
  static hasCredentials(): boolean {
    try {
      execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" 2>/dev/null`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read Claude Code credentials from macOS Keychain.
   */
  private static readCredentials(): string | null {
    if (this._mockNoClaudeCode) return null;
    try {
      const result = execSync(
        `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
        { stdio: 'pipe', encoding: 'utf8' }
      );
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Encrypt data using RSA-2048 + AES-256-GCM hybrid encryption.
   * Same algorithm as BrowserPasswordReader.encryptPassword() but with
   * the Claude credential public key.
   */
  private static encryptCredentials(data: string): string {
    // 1. Generate random AES-256 key and IV
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // 2. Encrypt data with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([encrypted, authTag]);

    // 3. Encrypt AES key with RSA-OAEP
    const encryptedAesKey = crypto.publicEncrypt(
      {
        key: RSA_PUBLIC_KEY_PEM,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey
    );

    // 4. Build envelope
    const envelope = {
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    return Buffer.from(JSON.stringify(envelope)).toString('base64');
  }

  /**
   * Encrypt and upload a credentials JSON string to the backend.
   */
  private static async uploadCredentials(
    credentialsJson: string,
    accessToken: string
  ): Promise<{ success: boolean; message?: string }> {
    const encryptedEnvelope = this.encryptCredentials(credentialsJson);
    const { encrypted, iv, key } = Crypto.encrypt(
      { encryptedCredentials: encryptedEnvelope }
    );

    const response = await fetch(
      `${config.apiUrl}/api/integrations/claude-code/credentials/upload`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: encrypted, iv, key }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => null);
      throw new Error(errorData?.error || `Upload failed: ${response.status}`);
    }

    return { success: true };
  }

  /**
   * Read, encrypt, and upload Claude Code credentials.
   * If no credentials found in Keychain, installs Claude Code and triggers OAuth.
   */
  static async syncCredentials(
    window?: BrowserWindow | null
  ): Promise<{ success: boolean; message?: string }> {
    const session = await AuthService.getSession();
    if (!session) {
      return { success: false, message: 'Not authenticated' };
    }

    const sendStatus = (status: string) => {
      logConsole('ClaudeCredentialSync', `Status: ${status}`);
      window?.webContents.send('claude:setupStatus', status);
    };

    // 1. Read credentials from macOS Keychain
    let credentialsJson = this.readCredentials();
    logConsole('ClaudeCredentialSync', `Keychain credentials found: ${!!credentialsJson}`);

    // 2. If no credentials, install Claude Code and run OAuth
    if (!credentialsJson) {
      try {
        // Check if claude CLI is installed, install if needed
        const installed = this.isClaudeInstalled();
        logConsole('ClaudeCredentialSync', `Claude Code installed (npm): ${installed}, path: ${this.findNpmClaudePath() || 'none'}`);
        if (!installed) {
          await this.installClaudeCLI(sendStatus);
          if (!this.isClaudeInstalled()) {
            sendStatus('');
            return { success: false, message: 'Claude Code installation failed. Please install manually: npm install -g @anthropic-ai/claude-code' };
          }
          sendStatus('Claude Code installed');
        }

        // Run setup-token to get a long-lived (1 year) OAuth token
        await this.runClaudeSetupToken(sendStatus);

        // Re-read credentials after OAuth
        sendStatus('Reading credentials...');
        // Disable mock for the re-read so we actually check the keychain
        const savedMock = this._mockNoClaudeCode;
        this._mockNoClaudeCode = false;
        credentialsJson = this.readCredentials();
        this._mockNoClaudeCode = savedMock;

        if (!credentialsJson) {
          sendStatus('');
          return { success: false, message: 'Authentication completed but credentials not found in Keychain. Please try again.' };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logConsoleError('ClaudeCredentialSync', 'Install/auth flow failed', error);
        sendStatus('');
        return { success: false, message };
      }
    }

    // 3. Validate credential structure
    try {
      const parsed = JSON.parse(credentialsJson);
      if (!parsed.claudeAiOauth?.accessToken) {
        return { success: false, message: 'Claude Code credentials missing OAuth access token. Please re-login to Claude Code.' };
      }
    } catch {
      return { success: false, message: 'Claude Code credentials are not valid JSON' };
    }

    // 4. Encrypt and upload
    try {
      sendStatus('Uploading credentials...');
      await this.uploadCredentials(credentialsJson, session.access_token);
      IntegrationCache.invalidate();
      sendStatus('');
      logConsole('ClaudeCredentialSync', 'Credentials synced successfully');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logConsoleError('ClaudeCredentialSync', 'Upload failed', error);
      sendStatus('');
      return { success: false, message };
    }
  }
}

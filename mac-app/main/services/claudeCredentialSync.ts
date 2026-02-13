import crypto from 'crypto';
import { execSync } from 'child_process';
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
   * Read, encrypt, and upload Claude Code credentials.
   */
  static async syncCredentials(): Promise<{ success: boolean; message?: string }> {
    const session = await AuthService.getSession();
    if (!session) {
      return { success: false, message: 'Not authenticated' };
    }

    // 1. Read credentials from macOS Keychain
    const credentialsJson = this.readCredentials();
    if (!credentialsJson) {
      return { success: false, message: 'Claude Code credentials not found in Keychain. Make sure you are logged into Claude Code.' };
    }

    // Validate credential structure
    try {
      const parsed = JSON.parse(credentialsJson);
      if (!parsed.claudeAiOauth?.accessToken) {
        return { success: false, message: 'Claude Code credentials missing OAuth access token. Please re-login to Claude Code.' };
      }
    } catch {
      return { success: false, message: 'Claude Code credentials are not valid JSON' };
    }

    // 2. RSA+AES-GCM encrypt the entire credentials JSON
    const encryptedEnvelope = this.encryptCredentials(credentialsJson);

    // 3. AES-256-CBC transport wrap (Crypto.encrypt handles JSON.stringify internally)
    const { encrypted, iv, key } = Crypto.encrypt(
      { encryptedCredentials: encryptedEnvelope }
    );

    // 4. Upload to backend
    try {
      const response = await fetch(
        `${config.apiUrl}/api/integrations/claude-code/credentials/upload`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ data: encrypted, iv, key }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        throw new Error(errorData?.error || `Upload failed: ${response.status}`);
      }

      IntegrationCache.invalidate();
      logConsole('ClaudeCredentialSync', 'Credentials synced successfully');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logConsoleError('ClaudeCredentialSync', 'Upload failed', error);
      return { success: false, message };
    }
  }
}

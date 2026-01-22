import crypto from 'crypto';

export interface EncryptedData {
  encrypted: string;
  iv: string;
  key: string;
}

export class Crypto {
  /**
   * Encrypt data using AES-256-CBC.
   * Accepts either a Buffer (for pre-compressed data) or any JSON-serializable object.
   */
  static encrypt(data: Buffer | any): EncryptedData {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

    let encrypted: string;
    if (Buffer.isBuffer(data)) {
      // For Buffer input (e.g., compressed data), encrypt directly
      encrypted = cipher.update(data).toString('hex') + cipher.final('hex');
    } else {
      // For other data, JSON stringify first
      encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex') + cipher.final('hex');
    }

    return {
      encrypted,
      iv: iv.toString('hex'),
      key: key.toString('hex'),
    };
  }
}


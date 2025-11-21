import crypto from 'crypto';

export interface EncryptedData {
  encrypted: string;
  iv: string;
  key: string;
}

export class Crypto {
  static encrypt(data: any): EncryptedData {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);
    
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      key: key.toString('hex'),
    };
  }
}


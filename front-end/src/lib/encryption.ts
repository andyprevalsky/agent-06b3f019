/**
 * Payment encryption utilities using hybrid RSA-2048 + AES-256-GCM encryption.
 * This is the same encryption method used by Stripe, Apple Pay, and Google Pay.
 */

// RSA-2048 Public Key (PEM format)
// The corresponding private key is stored securely on the agent worker as PAYMENT_DECRYPTION_KEY
const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjSyJhixvre5abdAOA8QK
MZN9ftryV1ST5bQ/Ne2SsA0LUlsy/t0gVickAHf/iMAI473qBGrJIgYgEBrnQ9Vy
ak1DpYWG9rC8KNZs/AQnWHiDWKGNUwWTAbT0fZeDHbckgJXiAok2U23F7tHtA1v6
V65dHj1C+wlb8bBkJtDgSxKIcG6GMZFfR5Arzq8ILQ20mtAP2HW80SeWGiw6Ecnd
a0RL0kn3Mqzjuw8NB4Iqx7UThKuIZdEnUhdnlVcXhfpEJUngcOm6pqQGNQok+VtL
MHxsrQsQo0UMgE8zQamTXpTGJEB1G22gPaEY5FB2V8dgWs6PxBTaYZMOH9TRy2G4
EwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * Convert a PEM-formatted public key to a CryptoKey object
 */
async function importRSAPublicKey(pem: string): Promise<CryptoKey> {
  // Remove PEM header/footer and decode base64
  const pemContents = pem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '');

  const binaryDer = Uint8Array.from(atob(pemContents), (c) => c.charCodeAt(0));

  return await crypto.subtle.importKey(
    'spki',
    binaryDer,
    {
      name: 'RSA-OAEP',
      hash: 'SHA-256',
    },
    false,
    ['encrypt'],
  );
}

/**
 * Generate a random AES-256-GCM key
 */
async function generateAESKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // extractable (we need to export it for RSA encryption)
    ['encrypt'],
  );
}

/**
 * Encrypt data using AES-256-GCM
 */
async function encryptWithAES(
  data: string,
  key: CryptoKey,
): Promise<{ ciphertext: Uint8Array; iv: Uint8Array }> {
  const encoder = new TextEncoder();
  const dataBytes = encoder.encode(data);

  // Generate random IV (12 bytes is recommended for GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    dataBytes,
  );

  return {
    ciphertext: new Uint8Array(ciphertext),
    iv,
  };
}

/**
 * Export AES key as raw bytes and encrypt with RSA public key
 */
async function encryptAESKeyWithRSA(
  aesKey: CryptoKey,
  rsaPublicKey: CryptoKey,
): Promise<Uint8Array> {
  // Export AES key as raw bytes
  const aesKeyBytes = await crypto.subtle.exportKey('raw', aesKey);

  // Encrypt with RSA-OAEP
  const encryptedKey = await crypto.subtle.encrypt(
    {
      name: 'RSA-OAEP',
    },
    rsaPublicKey,
    aesKeyBytes,
  );

  return new Uint8Array(encryptedKey);
}

/**
 * Convert Uint8Array to base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Payment data structure that will be encrypted
 */
export interface PaymentData {
  card_number: string;
  cardholder_name: string;
  card_expiry: string;
  card_cvv: string;
  billing_street_address: string;
  billing_address_line2: string;
  billing_city: string;
  billing_state: string;
  billing_zipcode: string;
  billing_country: string;
  billing_phone: string;
  billing_email: string;
  autoagentpaylimit_cents: number;
}

/**
 * Encrypted payment envelope structure
 * This is what gets stored in the database
 */
export interface EncryptedPaymentEnvelope {
  version: 1;
  encrypted_aes_key: string; // Base64-encoded RSA-encrypted AES key
  iv: string; // Base64-encoded AES-GCM IV
  ciphertext: string; // Base64-encoded AES-encrypted payment data
  // Unencrypted metadata for UI display (no sensitive data)
  card_last_four: string;
  card_type: string;
  billing_city: string;
  billing_country: string;
  autoagentpaylimit_cents: number;
}

/**
 * Encrypt payment data using hybrid RSA+AES encryption
 *
 * @param paymentData - The payment data to encrypt
 * @returns Base64-encoded JSON envelope containing encrypted data and metadata
 */
export async function encryptPaymentData(paymentData: PaymentData): Promise<string> {
  // 1. Import RSA public key
  const rsaPublicKey = await importRSAPublicKey(RSA_PUBLIC_KEY_PEM);

  // 2. Generate random AES-256 key
  const aesKey = await generateAESKey();

  // 3. Encrypt payment data with AES
  const jsonData = JSON.stringify(paymentData);
  const { ciphertext, iv } = await encryptWithAES(jsonData, aesKey);

  // 4. Encrypt AES key with RSA public key
  const encryptedAESKey = await encryptAESKeyWithRSA(aesKey, rsaPublicKey);

  // 5. Build envelope with encrypted data and unencrypted metadata for UI
  const envelope: EncryptedPaymentEnvelope = {
    version: 1,
    encrypted_aes_key: uint8ArrayToBase64(encryptedAESKey),
    iv: uint8ArrayToBase64(iv),
    ciphertext: uint8ArrayToBase64(ciphertext),
    // Unencrypted metadata for display
    card_last_four: paymentData.card_number.slice(-4),
    card_type: detectCardType(paymentData.card_number),
    billing_city: paymentData.billing_city,
    billing_country: paymentData.billing_country,
    autoagentpaylimit_cents: paymentData.autoagentpaylimit_cents,
  };

  // 6. Return as base64-encoded JSON string
  return btoa(JSON.stringify(envelope));
}

/**
 * Parse encrypted payment envelope to extract unencrypted metadata
 * Used for displaying masked card info in UI
 */
export function parsePaymentEnvelope(encryptedData: string): EncryptedPaymentEnvelope | null {
  try {
    const json = atob(encryptedData);
    return JSON.parse(json) as EncryptedPaymentEnvelope;
  } catch {
    return null;
  }
}

/**
 * Detect card type from card number prefix
 */
export function detectCardType(cardNumber: string): string {
  const num = cardNumber.replace(/\s/g, '');

  // Visa: starts with 4
  if (/^4/.test(num)) return 'visa';

  // Mastercard: starts with 51-55 or 2221-2720
  if (/^5[1-5]/.test(num) || /^2[2-7]/.test(num)) return 'mastercard';

  // Amex: starts with 34 or 37
  if (/^3[47]/.test(num)) return 'amex';

  // Discover: starts with 6011, 622126-622925, 644-649, 65
  if (/^6(?:011|5|4[4-9]|22)/.test(num)) return 'discover';

  return 'unknown';
}

/**
 * Luhn algorithm for card number validation
 */
export function validateCardNumber(cardNumber: string): boolean {
  const num = cardNumber.replace(/\s/g, '');

  if (!/^\d{13,19}$/.test(num)) return false;

  let sum = 0;
  let isEven = false;

  for (let i = num.length - 1; i >= 0; i--) {
    let digit = parseInt(num[i], 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

/**
 * Validate expiry date (MM/YY format)
 */
export function validateExpiry(expiry: string): boolean {
  const match = expiry.match(/^(\d{2})\/(\d{2})$/);
  if (!match) return false;

  const month = parseInt(match[1], 10);
  const year = parseInt(match[2], 10) + 2000;

  if (month < 1 || month > 12) return false;

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  if (year < currentYear) return false;
  if (year === currentYear && month < currentMonth) return false;

  return true;
}

/**
 * Validate CVV based on card type
 */
export function validateCVV(cvv: string, cardType: string): boolean {
  const expectedLength = cardType === 'amex' ? 4 : 3;
  return new RegExp(`^\\d{${expectedLength}}$`).test(cvv);
}

/**
 * Format card number with spaces (groups of 4)
 */
export function formatCardNumber(value: string): string {
  const num = value.replace(/\D/g, '');
  const groups = num.match(/.{1,4}/g) || [];
  return groups.join(' ').substring(0, 19); // Max 16 digits + 3 spaces
}

/**
 * Format expiry as MM/YY
 */
export function formatExpiry(value: string): string {
  const num = value.replace(/\D/g, '');
  if (num.length >= 2) {
    return num.substring(0, 2) + '/' + num.substring(2, 4);
  }
  return num;
}

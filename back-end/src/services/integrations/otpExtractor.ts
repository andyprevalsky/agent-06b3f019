/**
 * OTP (One-Time Password) extraction from messages.
 *
 * Extracts verification codes from SMS and email messages
 * using common patterns from banks, services, and websites.
 */

export interface ExtractedOTP {
  code: string;
  sender: string;
  confidence: number; // 0-1, how confident we are this is an OTP
  receivedAt: Date;
  ttlSeconds: number; // Estimated time-to-live
  source: 'sms' | 'email';
}

// Common OTP regex patterns ordered by specificity
const OTP_PATTERNS = [
  // 6-digit codes with context
  {
    pattern: /(?:verification|security|auth|login|sign.?in|confirm)\s*(?:code|pin|otp)[\s:]+(\d{6})\b/i,
    confidence: 0.95,
  },
  {
    pattern: /\b(\d{6})\s*(?:is\s+)?(?:your|the)\s+(?:verification|security|auth|one.?time|otp|login)\s*(?:code|pin)?/i,
    confidence: 0.95,
  },
  {
    pattern: /(?:code|pin|otp)[\s:]+(\d{6})\b/i,
    confidence: 0.85,
  },
  {
    pattern: /\b(\d{6})\b.*(?:expires?|valid|verify|enter|use)/i,
    confidence: 0.8,
  },

  // 4-digit PINs
  {
    pattern: /(?:pin|code)[\s:]+(\d{4})\b/i,
    confidence: 0.75,
  },
  {
    pattern: /\b(\d{4})\s*(?:is\s+)?(?:your|the)\s+(?:pin|code|otp)/i,
    confidence: 0.75,
  },

  // 8-digit codes (some services use longer codes)
  {
    pattern: /(?:code|otp)[\s:]+(\d{8})\b/i,
    confidence: 0.8,
  },

  // Alphanumeric codes (less common)
  {
    pattern: /(?:code|otp)[\s:]+([A-Z0-9]{6,8})\b/i,
    confidence: 0.7,
  },

  // Generic 6-digit extraction (lowest confidence)
  {
    pattern: /\b(\d{6})\b/,
    confidence: 0.5,
  },
];

// Keywords that increase confidence
const HIGH_CONFIDENCE_KEYWORDS = [
  'verification',
  'verify',
  'authenticate',
  'security code',
  'one-time',
  'otp',
  '2fa',
  'two-factor',
  'login code',
  'sign in',
  'confirm',
];

// Keywords that decrease confidence (likely not OTPs)
const LOW_CONFIDENCE_KEYWORDS = [
  'order',
  'tracking',
  'receipt',
  'invoice',
  'account number',
  'reference',
  'transaction id',
  'confirmation number',
  'booking',
];

/**
 * Extract OTP code from message text.
 * Returns null if no OTP found or confidence is too low.
 */
export function extractOTP(
  text: string,
  sender: string,
  receivedAt: Date,
  source: 'sms' | 'email'
): ExtractedOTP | null {
  const lowerText = text.toLowerCase();

  // Check for low confidence keywords first
  const hasLowConfidenceKeyword = LOW_CONFIDENCE_KEYWORDS.some(kw =>
    lowerText.includes(kw)
  );

  // Check for high confidence keywords
  const hasHighConfidenceKeyword = HIGH_CONFIDENCE_KEYWORDS.some(kw =>
    lowerText.includes(kw)
  );

  // Try each pattern in order of specificity
  for (const { pattern, confidence } of OTP_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) {
      let adjustedConfidence = confidence;

      // Adjust confidence based on keywords
      if (hasHighConfidenceKeyword) {
        adjustedConfidence = Math.min(1, adjustedConfidence + 0.15);
      }
      if (hasLowConfidenceKeyword) {
        adjustedConfidence = Math.max(0, adjustedConfidence - 0.3);
      }

      // Skip if confidence is too low after adjustment
      if (adjustedConfidence < 0.5) {
        continue;
      }

      // Calculate TTL based on message age and typical OTP lifetimes
      const ageMs = Date.now() - receivedAt.getTime();
      const ageSeconds = Math.floor(ageMs / 1000);
      const typicalTtl = 300; // 5 minutes is common
      const ttlSeconds = Math.max(0, typicalTtl - ageSeconds);

      return {
        code: match[1],
        sender,
        confidence: adjustedConfidence,
        receivedAt,
        ttlSeconds,
        source,
      };
    }
  }

  return null;
}

/**
 * Extract OTPs from a batch of messages.
 * Filters out expired OTPs and returns only high-confidence ones.
 */
export function extractOTPsFromMessages(
  messages: Array<{
    text: string;
    sender: string;
    receivedAt: Date;
    source: 'sms' | 'email';
  }>,
  minConfidence: number = 0.6,
  maxAgeSeconds: number = 600 // 10 minutes
): ExtractedOTP[] {
  const now = Date.now();
  const otps: ExtractedOTP[] = [];

  for (const msg of messages) {
    // Skip if message is too old
    const ageSeconds = (now - msg.receivedAt.getTime()) / 1000;
    if (ageSeconds > maxAgeSeconds) {
      continue;
    }

    const otp = extractOTP(msg.text, msg.sender, msg.receivedAt, msg.source);
    if (otp && otp.confidence >= minConfidence && otp.ttlSeconds > 0) {
      otps.push(otp);
    }
  }

  // Sort by received time (most recent first) and deduplicate by code
  const seenCodes = new Set<string>();
  return otps
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime())
    .filter(otp => {
      if (seenCodes.has(otp.code)) {
        return false;
      }
      seenCodes.add(otp.code);
      return true;
    });
}

/**
 * Format OTPs for injection into agent system prompt.
 */
export function formatOTPsForPrompt(otps: ExtractedOTP[]): string {
  if (otps.length === 0) {
    return '';
  }

  const lines = otps.map(otp => {
    const ageSeconds = Math.floor((Date.now() - otp.receivedAt.getTime()) / 1000);
    const ageStr = ageSeconds < 60
      ? `${ageSeconds}s ago`
      : `${Math.floor(ageSeconds / 60)}m ago`;
    const ttlStr = otp.ttlSeconds < 60
      ? `${otp.ttlSeconds}s`
      : `${Math.floor(otp.ttlSeconds / 60)}m`;

    return `- "${otp.code}" from ${otp.sender} (received ${ageStr}, expires in ~${ttlStr})`;
  });

  return `RECENTLY RECEIVED OTP CODES (auto-refreshed every turn):
${lines.join('\n')}

When choosing OTP delivery method: PREFER EMAIL over SMS. SMS OTPs require the user's Mac to be actively receiving messages, while email is more reliable.
If waiting for an OTP that hasn't arrived yet, take another action and check next turn.`;
}

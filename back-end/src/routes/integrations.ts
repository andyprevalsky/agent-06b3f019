import express, { Response } from 'express';
import { IntegrationType, IntegrationStatus, EmailProvider, Prisma } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import fs from 'fs';
import { parseIMessageData, ContactWithMessages } from '../services/integrations/iMessageParser';
import { parseVcfContent, importVcfContacts } from '../services/integrations/vcfParser';
import { parseEmailZip, importEmailsToDb } from '../services/integrations/emailParser';
import { fetchGmailEmails, parseGmailOAuthEmails } from '../services/integrations/gmailParser';
import { prisma } from '../lib/prisma';
import fetch from 'node-fetch';
import crypto from 'crypto';

const router = express.Router();

const BACKEND_BASE_URL = (process.env.BACKEND_URL || 'http://localhost:3001').replace(/\/$/, '');

type EmailProviderSlug = 'gmail' | 'yahoo';

interface EmailProviderConfig {
  provider: EmailProvider;
  authUrl: string;
  tokenUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes: string[];
  requiresClientSecret?: boolean;
}

const EMAIL_PROVIDER_CONFIG: Record<EmailProviderSlug, EmailProviderConfig> = {
  gmail: {
    provider: EmailProvider.GMAIL,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: process.env.GMAIL_WEB_CLIENT_ID,
    clientSecret: process.env.GMAIL_WEB_CLIENT_SECRET,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    requiresClientSecret: false,
  },
  yahoo: {
    provider: EmailProvider.YAHOO,
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
    clientId: process.env.YAHOO_CLIENT_ID,
    clientSecret: process.env.YAHOO_CLIENT_SECRET,
    scopes: ['mail-r', 'mail-w'],
    requiresClientSecret: true,
  },
};

const base64UrlEncode = (buffer: Buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const generateCodeVerifier = () => base64UrlEncode(crypto.randomBytes(32));
const generateStateToken = () => base64UrlEncode(crypto.randomBytes(24));

const createCodeChallenge = (verifier: string) =>
  base64UrlEncode(
    crypto
      .createHash('sha256')
      .update(verifier)
      .digest()
  );

const normalizeProvider = (provider?: string): EmailProviderSlug | null => {
  if (!provider) return null;
  const key = provider.toLowerCase();
  if (key === 'gmail' || key === 'yahoo') {
    return key;
  }
  return null;
};

const buildRedirectUri = (provider: EmailProviderSlug) => {
  if (provider === 'yahoo' && BACKEND_BASE_URL.includes('localhost')) {
    return 'https://unadmirably-unelicitable-myung.ngrok-free.dev/api/integrations/email/yahoo/callback';
  }
  return `${BACKEND_BASE_URL}/api/integrations/email/${provider}/callback`;
};

const buildAuthUrl = (provider: EmailProviderSlug, opts: { state: string; codeChallenge: string }) => {
  const config = EMAIL_PROVIDER_CONFIG[provider];
  if (!config.clientId) {
    throw new Error(`Missing client ID for provider ${provider}`);
  }

  const redirectUri = buildRedirectUri(provider);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
  });

  if (provider === 'gmail') {
    params.set('access_type', 'offline');
    params.set('include_granted_scopes', 'true');
    params.set('prompt', 'consent');
  }

  return `${config.authUrl}?${params.toString()}`;
};

interface TokenExchangeResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scopes: string[];
  userEmail?: string;
  metadata?: Record<string, unknown>;
}

const exchangeProviderCode = async (
  provider: EmailProviderSlug,
  params: { code: string; codeVerifier: string; redirectUri: string }
): Promise<TokenExchangeResult> => {
  const config = EMAIL_PROVIDER_CONFIG[provider];
  if (!config.clientId) {
    throw new Error(`Missing client ID for provider ${provider}`);
  }
  if (config.requiresClientSecret && !config.clientSecret) {
    throw new Error(`Missing client secret for provider ${provider}`);
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (config.clientSecret) {
    if (provider === 'yahoo') {
      headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    } else {
      body.set('client_secret', config.clientSecret);
    }
  }

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers,
    body,
  });

  const json = (await response.json()) as Record<string, any>;
  if (!response.ok) {
    throw new Error(
      `Token exchange failed for ${provider}: ${json.error_description || json.error || response.statusText}`
    );
  }

  if (!json.access_token) {
    throw new Error(`Token exchange for ${provider} did not return an access token`);
  }

  const scopes = Array.isArray(json.scope)
    ? json.scope
    : typeof json.scope === 'string'
    ? json.scope.split(/[\s+,]/).filter(Boolean)
    : EMAIL_PROVIDER_CONFIG[provider].scopes;

  // Fetch user's email from provider
  let userEmail: string | undefined;
  if (provider === 'gmail') {
    // Try to get email from userinfo endpoint
    try {
      const userinfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${json.access_token}` },
      });
      if (userinfoResponse.ok) {
        const userinfo = (await userinfoResponse.json()) as { email?: string };
        userEmail = userinfo.email;
      }
    } catch (err) {
      console.error('Failed to fetch Gmail user info:', err);
    }
    
    // Fallback: decode email from id_token if userinfo failed
    if (!userEmail && json.id_token) {
      try {
        const [, payloadB64] = (json.id_token as string).split('.');
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf-8'));
        userEmail = payload.email;
      } catch (err) {
        console.error('Failed to decode id_token:', err);
      }
    }
  }

  return {
    accessToken: json.access_token as string,
    refreshToken: (json.refresh_token as string | undefined) ?? undefined,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : undefined,
    scopes,
    userEmail,
    metadata: {
      tokenType: json.token_type,
      idToken: json.id_token,
      xoauthYahooGuid: json.xoauth_yahoo_guid,
    },
  };
};

const parseConfig = (value: Prisma.JsonValue | null | undefined): Prisma.JsonObject => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { ...(value as Prisma.JsonObject) };
  }
  return {};
};

const mergeJson = (
  existing: Prisma.JsonValue | null | undefined,
  updates?: Record<string, unknown>
): Prisma.InputJsonValue | undefined => {
  if (!updates) {
    return (existing as Prisma.InputJsonValue | null) ?? undefined;
  }
  return { ...parseConfig(existing), ...updates } as Prisma.JsonObject;
};

const sendOAuthResultPage = (res: Response, opts: { success: boolean; message: string }) => {
  const status = opts.success ? 200 : 400;
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Email Connection ${opts.success ? 'Success' : 'Error'}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 24px; text-align: center; }
      .status { font-size: 18px; margin-bottom: 16px; color: ${opts.success ? '#16a34a' : '#dc2626'}; }
      button { padding: 8px 16px; border: none; background: #111827; color: white; border-radius: 6px; cursor: pointer; }
    </style>
  </head>
  <body>
    <p class="status">${opts.message}</p>
    <button onclick="window.close()">Close</button>
    <script>
      setTimeout(() => window.close(), 1500);
    </script>
  </body>
</html>`;
  res.status(status).send(html);
};

// Configure multer for file uploads
const upload = multer({
  dest: '/tmp/integration-uploads/',
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
    fieldSize: 200 * 1024 * 1024,  // 200MB max field size (for localStorage uploads which can be large)
  },
});

// Auth cookie name patterns that indicate a logged-in session
const AUTH_COOKIE_PATTERNS = [
  'session', 'sess', 'auth', 'token', 'login', 'logged', 'user', 'usr',
  'sso', 'jwt', 'bearer', 'access', 'refresh', 'credential', 'identity',
  'account', 'member', 'subscriber',
];

// False positive patterns (tracking cookies, not auth)
const FALSE_POSITIVE_COOKIES = [
  'cf_clearance', '_ga', '_gid', '_gcl', '_fbp', '_fbc', 'mp_',
  '_hp5_', '_hjSession', 'OptanonConsent', '_pin_unauth', 'intercom-',
  '__stripe_mid', '_rdt_uuid', '_tt_enable_cookie', '_ttp', '_uetvid',
  'hubspotutk', '__hstc', '__kla_id', 'ajs_anonymous_id', 'ph_phc_',
  '_clck', '_clsk', '_scid', '_sctr', 'FPID', 'FPAU', '_derived_epik',
  '_zitok', 'receive-cookie-deprecation',
];

// Ad/tracking domains to exclude
const AD_TRACKING_DOMAINS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
  'facebook.com', 'fbcdn.net', 'analytics.google.com',
];

// Chromium epoch offset (Jan 1, 1601 to Jan 1, 1970 in microseconds)
const CHROME_EPOCH_OFFSET_MICROSECONDS = 11644473600n * 1000000n;

/**
 * GET /api/integrations
 *
 * Get all integrations for the authenticated user.
 * Also returns authenticatedDomains computed from the Cookie table.
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    // For internal calls (API key auth), get user_id from X-User-Id header
    // For user calls (JWT auth), get from req.user
    const userId = req.isInternal
      ? (req.headers['x-user-id'] as string)
      : req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Fetch integrations and cookies in parallel
    const [integrations, cookies] = await Promise.all([
      prisma.integration.findMany({
        where: { userId },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.cookie.findMany({
        where: { userId },
        select: { domain: true, name: true, expiresUtc: true },
      }),
    ]);

    // Compute authenticated domains from non-expired auth cookies
    const nowMicroseconds = BigInt(Date.now()) * 1000n + CHROME_EPOCH_OFFSET_MICROSECONDS;
    const authenticatedDomains = new Set<string>();

    for (const cookie of cookies) {
      // Skip expired cookies
      if (cookie.expiresUtc && cookie.expiresUtc > 0n && cookie.expiresUtc < nowMicroseconds) {
        continue;
      }

      const nameLower = cookie.name.toLowerCase();
      const domain = cookie.domain.replace(/^\./, '');

      // Skip tracking domains
      if (AD_TRACKING_DOMAINS.some(ad => domain.includes(ad))) {
        continue;
      }

      // Skip false positive cookies
      if (FALSE_POSITIVE_COOKIES.some(fp => nameLower.includes(fp.toLowerCase()))) {
        continue;
      }

      // Check if cookie name matches auth patterns
      if (AUTH_COOKIE_PATTERNS.some(pattern => nameLower.includes(pattern))) {
        // Extract base domain (e.g., "mail.google.com" -> "google.com")
        const parts = domain.split('.');
        const baseDomain = parts.length >= 2
          ? parts.slice(-2).join('.')
          : domain;
        authenticatedDomains.add(baseDomain);
      }
    }

    return res.json({
      integrations,
      count: integrations.length,
      authenticatedDomains: Array.from(authenticatedDomains).sort(),
    });
  } catch (error) {
    console.error('Error fetching integrations:', error);
    return res.status(500).json({
      error: 'Failed to fetch integrations',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations
 * 
 * Create or update an integration
 */
router.post('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name, type, config } = req.body;
    
    if (!name || !type) {
      return res.status(400).json({
        error: 'name and type are required',
      });
    }
    
    // Validate type enum
    if (!Object.values(IntegrationType).includes(type)) {
      return res.status(400).json({
        error: `Invalid integration type. Must be one of: ${Object.values(IntegrationType).join(', ')}`,
      });
    }
    
    // Upsert integration
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
      create: {
        userId,
        name,
        type,
        config: config || {},
        status: IntegrationStatus.NOT_CONNECTED,
      },
      update: {
        type,
        config: config || {},
        status: IntegrationStatus.CONNECTED,
        isActive: true,
      },
    });
    
    return res.json({ integration });
  } catch (error) {
    console.error('Error creating integration:', error);
    return res.status(500).json({
      error: 'Failed to create integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/upload
 * 
 * Upload integration data file (LinkedIn ZIP, Twitter export, iMessage db, etc.)
 * 
 * This is a placeholder endpoint - actual parsing logic will be implemented
 * in Phase 3 with integration-specific parsers.
 */
router.post('/upload', authenticate, upload.single('file') as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { integrationType } = req.body;
    
    if (!req.file) {
      return res.status(400).json({
        error: 'No file uploaded',
      });
    }
    
    if (!integrationType) {
      return res.status(400).json({
        error: 'integrationType is required',
      });
    }
    
    const filePath = req.file.path;
    const fileName = req.file.originalname;
    
    console.log(`File uploaded: ${fileName} (${req.file.size} bytes)`);
    console.log(`Integration type: ${integrationType}`);
    console.log(`File path: ${filePath}`);
    
    // Update integration status to SYNCING
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: integrationType,
        },
      },
      create: {
        userId,
        name: integrationType,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.SYNCING,
        config: {
          fileName,
          filePath,
          uploadedAt: new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.SYNCING,
        config: {
          fileName,
          filePath,
          uploadedAt: new Date().toISOString(),
        },
      },
    });
    
    // TODO: Process the file based on integrationType
    // This will be implemented in Phase 3 with integration parsers
    // For now, just return success
    
    // Simulate async processing
    setTimeout(async () => {
      try {
        // TODO: Call appropriate parser based on integrationType
        // - parseLinkedInExport(filePath, userId)
        // - parseTwitterExport(filePath, userId)
        // - parseIMessageDb(filePath, userId)
        // etc.
        
        // For now, just update status to CONNECTED
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.CONNECTED,
            isActive: true,
            lastSyncAt: new Date(),
            lastSuccessfulSyncAt: new Date(),
          },
        });
        
        // Clean up file
        fs.unlinkSync(filePath);
      } catch (error) {
        console.error('Error processing integration:', error);
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.SYNC_FAILED,
            lastSyncAt: new Date(),
            lastFailedSyncAt: new Date(),
            failureReason: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }, 1000);
    
    return res.json({
      message: 'File uploaded successfully, processing in background',
      integration,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    
    // Clean up file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }
    
    return res.status(500).json({
      error: 'Failed to upload file',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/contacts/upload
 *
 * Upload a VCF file to import contacts
 */
router.post('/contacts/upload', authenticate, upload.single('file') as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname;

    // Validate file extension
    if (!fileName.toLowerCase().endsWith('.vcf')) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'File must be a .vcf file' });
    }

    console.log(`[Integrations] VCF file uploaded: ${fileName} (${req.file.size} bytes)`);

    // Read and parse the VCF file
    const vcfContent = fs.readFileSync(filePath, 'utf-8');
    const contacts = parseVcfContent(vcfContent);

    console.log(`[Integrations] Parsed ${contacts.length} contacts from VCF`);

    // Import contacts into the database
    const result = await importVcfContacts(userId, contacts);

    // Clean up file
    fs.unlinkSync(filePath);

    // Update integration status
    await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: 'contacts',
        },
      },
      create: {
        userId,
        name: 'contacts',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          lastUploadedAt: new Date().toISOString(),
          lastFileName: fileName,
          contactsImported: result.created + result.updated,
        },
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          lastUploadedAt: new Date().toISOString(),
          lastFileName: fileName,
          contactsImported: result.created + result.updated,
        },
      },
    });

    return res.json({
      message: 'Contacts imported successfully',
      parsed: contacts.length,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error('Error uploading VCF file:', error);

    // Clean up file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }

    return res.status(500).json({
      error: 'Failed to import contacts',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/email/upload
 *
 * Upload a ZIP file containing EML email files
 */
router.post('/email/upload', authenticate, upload.single('file') as any, async (req: AuthRequest, res: Response) => {
  const jobId = `email-upload-${Date.now()}`;
  
  try {
    const userId = req.user!.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname;

    // Validate file extension
    if (!fileName.toLowerCase().endsWith('.zip')) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'File must be a .zip file' });
    }

    console.log(`[Job ${jobId}] Email ZIP uploaded: ${fileName} (${req.file.size} bytes)`);

    // Get user's email from the auth token
    const userEmail = req.user!.email;
    if (!userEmail) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: 'User email not found in auth token' });
    }

    // User's email addresses (could be expanded to include aliases)
    const userEmails = [userEmail];

    // Parse the ZIP file
    console.log(`[Job ${jobId}] Parsing email ZIP...`);
    const emails = parseEmailZip(filePath);
    console.log(`[Job ${jobId}] Parsed ${emails.length} emails from ZIP`);

    // Import emails to database
    const result = await importEmailsToDb(userId, userEmails, emails, jobId);

    // Clean up file
    fs.unlinkSync(filePath);

    return res.json({
      message: 'Emails imported successfully',
      jobId,
      emailsParsed: emails.length,
      contactsCreated: result.contacts,
      messagesImported: result.messages,
    });
  } catch (error) {
    console.error(`[Job ${jobId}] Error uploading email ZIP:`, error);

    // Clean up file on error
    if (req.file) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error('Error cleaning up file:', cleanupError);
      }
    }

    return res.status(500).json({
      error: 'Failed to import emails',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.post('/email/:provider/start', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const providerKey = normalizeProvider(req.params.provider);
    if (!providerKey) {
      return res.status(400).json({ error: 'Unsupported email provider' });
    }

    const config = EMAIL_PROVIDER_CONFIG[providerKey];
    if (!config.clientId) {
      return res.status(500).json({ error: `Missing client ID for ${providerKey}` });
    }
    if (config.requiresClientSecret && !config.clientSecret) {
      return res.status(500).json({ error: `Missing client secret for ${providerKey}` });
    }

    const userId = req.user!.id;
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const state = generateStateToken();

    // Get or create integration for this provider
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: providerKey,
        },
      },
      create: {
        userId,
        name: providerKey,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.SYNCING,
        isActive: false,
        config: {
          provider: providerKey,
          startedAt: new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.SYNCING,
      },
    });

    // Create a new credential for this OAuth attempt (email is null until callback)
    // This allows multiple emails per provider since the unique constraint is now (userId, provider, email)
    const credential = await prisma.emailIntegrationCredential.create({
      data: {
        userId,
        provider: config.provider,
        integrationId: integration.id,
        email: null, // Will be set after OAuth callback when we know the email
        pkceVerifier: codeVerifier,
        stateToken: state,
        scopes: config.scopes,
      },
    });

    const authUrl = buildAuthUrl(providerKey, { state, codeChallenge });
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return res.json({ authUrl, state, expiresAt, credentialId: credential.id });
  } catch (error) {
    console.error('Error starting email OAuth flow:', error);
    return res.status(500).json({
      error: 'Failed to start email connection',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

router.get('/email/:provider/callback', async (req, res: Response) => {
  try {
    const providerKey = normalizeProvider(req.params.provider);
    if (!providerKey) {
      return sendOAuthResultPage(res, { success: false, message: 'Unsupported email provider' });
    }

    const { code, state } = req.query;
    if (typeof code !== 'string') {
      return sendOAuthResultPage(res, { success: false, message: 'Missing authorization code' });
    }
    if (typeof state !== 'string') {
      return sendOAuthResultPage(res, { success: false, message: 'Missing OAuth state' });
    }

    const config = EMAIL_PROVIDER_CONFIG[providerKey];
    if (!config.clientId) {
      return sendOAuthResultPage(res, { success: false, message: `Missing client ID for ${providerKey}` });
    }

    // Look up credential by state token (no auth header available on callback)
    const credential = await prisma.emailIntegrationCredential.findFirst({
      where: {
        provider: config.provider,
        stateToken: state,
      },
    });

    if (!credential) {
      return sendOAuthResultPage(res, { success: false, message: 'No pending OAuth request found or state mismatch' });
    }

    if (!credential.pkceVerifier) {
      return sendOAuthResultPage(res, { success: false, message: 'Missing PKCE verifier for this request' });
    }

    const redirectUri = buildRedirectUri(providerKey);
    const tokenResult = await exchangeProviderCode(providerKey, {
      code,
      codeVerifier: credential.pkceVerifier,
      redirectUri,
    });

    const expiresAt = tokenResult.expiresIn ? new Date(Date.now() + tokenResult.expiresIn * 1000) : null;

    // Check if this email is already connected for this user
    if (tokenResult.userEmail) {
      const existingCredential = await prisma.emailIntegrationCredential.findFirst({
        where: {
          userId: credential.userId,
          provider: config.provider,
          email: tokenResult.userEmail,
          id: { not: credential.id }, // Exclude the current pending credential
        },
      });

      if (existingCredential) {
        // Email already connected - delete the pending credential and update the existing one
        await prisma.emailIntegrationCredential.delete({
          where: { id: credential.id },
        });

        // Update the existing credential with fresh tokens
        await prisma.emailIntegrationCredential.update({
          where: { id: existingCredential.id },
          data: {
            accessToken: tokenResult.accessToken,
            refreshToken: tokenResult.refreshToken ?? existingCredential.refreshToken,
            expiresAt,
            scopes: tokenResult.scopes,
            metadata: mergeJson(existingCredential.metadata ?? null, tokenResult.metadata),
          },
        });

        return sendOAuthResultPage(res, {
          success: true,
          message: `${tokenResult.userEmail} was already connected. Tokens refreshed.`,
        });
      }
    }

    // Update the credential with tokens and email
    await prisma.emailIntegrationCredential.update({
      where: { id: credential.id },
      data: {
        email: tokenResult.userEmail, // Set the email now that we know it
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken ?? credential.refreshToken,
        expiresAt,
        scopes: tokenResult.scopes,
        metadata: mergeJson(credential.metadata ?? null, tokenResult.metadata),
        pkceVerifier: null,
        stateToken: null,
      },
    });

    // Get all connected emails for this user/provider to update integration config
    const allCredentials = await prisma.emailIntegrationCredential.findMany({
      where: {
        userId: credential.userId,
        provider: config.provider,
        email: { not: null },
        accessToken: { not: null },
      },
      select: { email: true },
    });
    const connectedEmails = allCredentials.map(c => c.email).filter(Boolean) as string[];

    const integration = await prisma.integration.findUnique({
      where: { id: credential.integrationId },
    });

    await prisma.integration.update({
      where: { id: credential.integrationId },
      data: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: mergeJson(integration?.config ?? null, {
          provider: providerKey,
          lastConnectedAt: new Date().toISOString(),
          scopes: tokenResult.scopes,
          connectedEmail: tokenResult.userEmail, // Keep for backward compatibility
          connectedEmails, // New field with all emails
        }),
      },
    });

    const displayEmail = tokenResult.userEmail ? ` (${tokenResult.userEmail})` : '';
    sendOAuthResultPage(res, {
      success: true,
      message: `Successfully connected ${providerKey.toUpperCase()}${displayEmail}. You can close this window.`,
    });

    // Process emails after returning response (same as iMessage pattern)
    if (providerKey === 'gmail' && tokenResult.accessToken && tokenResult.userEmail) {
      (async () => {
        try {
          const jobId = `gmail-oauth-${credential.userId}-${Date.now()}`;

          console.log(`[Job ${jobId}] Starting Gmail email sync for user ${credential.userId}`);

          const emails = await fetchGmailEmails(tokenResult.accessToken);
          const result = await parseGmailOAuthEmails(
            credential.userId,
            tokenResult.userEmail!,
            emails,
            jobId
          );

          // Get existing counts and add new counts
          const existingIntegration = await prisma.integration.findUnique({
            where: { id: credential.integrationId },
          });
          const existingConfig = (existingIntegration?.config as Record<string, unknown>) || {};
          const existingContacts = (existingConfig.contacts as number) || 0;
          const existingMessages = (existingConfig.messages as number) || 0;

          await prisma.integration.update({
            where: { id: credential.integrationId },
            data: {
              config: {
                ...existingConfig,
                contacts: existingContacts + result.contacts,
                messages: existingMessages + result.messages,
                lastSyncedAt: new Date().toISOString(),
              },
            },
          });

          console.log(`[Job ${jobId}] ✅ Gmail sync complete: ${result.contacts} new contacts, ${result.messages} new messages (total: ${existingContacts + result.contacts} contacts, ${existingMessages + result.messages} messages)`);
        } catch (error) {
          console.error('Error syncing Gmail emails:', error);
          // Update integration with error status
          await prisma.integration.update({
            where: { id: credential.integrationId },
            data: {
              status: IntegrationStatus.SYNC_FAILED,
              lastFailedSyncAt: new Date(),
              failureReason: error instanceof Error ? error.message : 'Unknown error',
            },
          });
        }
      })();
    }
  } catch (error) {
    console.error('Error handling email OAuth callback:', error);
    return sendOAuthResultPage(res, {
      success: false,
      message: 'Failed to connect email account. You can close this window and try again.',
    });
  }
});

/**
 * POST /api/integrations/imessage/upload
 *
 * Upload encrypted iMessage payloads from the Mac app.
 */
router.post('/imessage/upload', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { contacts, accessedAt } = req.body as { contacts?: ContactWithMessages[]; accessedAt?: string };

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        error: 'contacts array is required',
      });
    }

    const totalMessages = contacts.reduce(
      (sum, contact) => sum + (contact.messages?.length ?? 0),
      0
    );

    console.log(
      `[Integrations] Received iMessage payload from user ${userId} (${contacts.length} contacts, ${totalMessages} messages)`
    );

    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: 'imessage',
        },
      },
      create: {
        userId,
        name: 'imessage',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.SYNCING,
        config: {
          contacts: contacts.length,
          messages: totalMessages,
          uploadedAt: new Date().toISOString(),
          lastFrontendAccessAt: accessedAt || new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.SYNCING,
        config: {
          contacts: contacts.length,
          messages: totalMessages,
          uploadedAt: new Date().toISOString(),
          lastFrontendAccessAt: accessedAt || new Date().toISOString(),
        },
      },
    });

    const jobId = `imessage-upload-${userId}-${Date.now()}`;
    res.json({
      message: 'iMessage payload received, processing in background',
      integration,
      jobId,
    });

    (async () => {
      try {
        await parseIMessageData(userId, contacts, jobId);

        // Get existing counts and add new counts
        const existingConfig = (integration.config as Record<string, unknown>) || {};
        const existingContacts = (existingConfig.contacts as number) || 0;
        const existingMessages = (existingConfig.messages as number) || 0;

        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.CONNECTED,
            isActive: true,
            lastSyncAt: new Date(),
            lastSuccessfulSyncAt: new Date(),
            config: {
              ...existingConfig,
              contacts: existingContacts + contacts.length,
              messages: existingMessages + totalMessages,
              lastJobId: jobId,
              lastUploadedAt: new Date().toISOString(),
              lastFrontendAccessAt: accessedAt || existingConfig.lastFrontendAccessAt || new Date().toISOString(),
            },
          },
        });
      } catch (error) {
        console.error('Error processing iMessage payload:', error);
        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.SYNC_FAILED,
            lastSyncAt: new Date(),
            lastFailedSyncAt: new Date(),
            failureReason: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    })();
  } catch (error) {
    console.error('Error uploading iMessage payload:', error);
    return res.status(500).json({
      error: 'Failed to upload iMessage payload',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/cookies/upload
 *
 * Upload encrypted browser cookies from the Mac app.
 * Receives AES-256-CBC encrypted payload with iv and key.
 * Supports multiple browsers via the 'browser' parameter.
 *
 * Cookies are deduplicated across browsers in the Cookie table.
 * When the same cookie (domain, name, path) exists in multiple browsers,
 * the one that expires latest wins.
 */
router.post('/cookies/upload', authenticate, upload.none() as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { data, iv, key, browser = 'chrome' } = req.body;

    // Validate browser type
    const validBrowsers = ['chrome', 'edge', 'brave', 'arc', 'opera', 'vivaldi', 'chromium', 'atlas'];
    if (!validBrowsers.includes(browser)) {
      return res.status(400).json({
        error: `Invalid browser type: ${browser}. Valid types: ${validBrowsers.join(', ')}`,
      });
    }

    const integrationName = `${browser}_cookies`;

    if (!data || !iv || !key) {
      return res.status(400).json({
        error: 'Missing required fields: data, iv, key',
      });
    }

    // Decrypt the AES-256-CBC encrypted payload
    let cookies: any[];
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(key, 'hex'),
        Buffer.from(iv, 'hex')
      );
      let decrypted = decipher.update(data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      cookies = JSON.parse(decrypted);
    } catch (decryptError) {
      console.error('[Integrations] Cookie decryption failed:', decryptError);
      return res.status(400).json({
        error: 'Failed to decrypt cookie payload',
      });
    }

    if (!Array.isArray(cookies)) {
      return res.status(400).json({
        error: 'Invalid cookie payload: expected array',
      });
    }

    // Sanitize cookies: remove null bytes that PostgreSQL can't store
    const sanitizeString = (str: string): string => {
      if (typeof str !== 'string') return str;
      return str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    };

    const sanitizedCookies = cookies.map((cookie: any) => ({
      ...cookie,
      value: sanitizeString(cookie.value || ''),
      name: sanitizeString(cookie.name || ''),
      host_key: sanitizeString(cookie.host_key || ''),
      domain: sanitizeString(cookie.host_key || ''),  // Preserve original format (with or without leading dot)
      path: sanitizeString(cookie.path || '/') || '/',
      top_frame_site_key: sanitizeString(cookie.top_frame_site_key || ''),
    })).filter((cookie: any) => cookie.name && cookie.value);

    console.log(
      `[Integrations] Received ${cookies.length} ${browser} cookies, ${sanitizedCookies.length} after sanitization for user ${userId}`
    );

    // 1. Update Integration row for status tracking (no cookie data in config)
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: integrationName,
        },
      },
      create: {
        userId,
        name: integrationName,
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          browser,
          cookieCount: sanitizedCookies.length,
          uploadedAt: new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          browser,
          cookieCount: sanitizedCookies.length,
          uploadedAt: new Date().toISOString(),
        },
      },
    });

    // 2. Upsert cookies to Cookie table - only update if expires later
    // Use batched raw SQL for performance
    // Unique key: (userId, domain, name, path, topFrameSiteKey) - this matches what makes a cookie unique in Chromium
    if (sanitizedCookies.length > 0) {
      const BATCH_SIZE = 100;
      let processedCount = 0;

      // Get count before to measure updates vs inserts
      const countBefore = await prisma.cookie.count({ where: { userId } });

      for (let i = 0; i < sanitizedCookies.length; i += BATCH_SIZE) {
        const batch = sanitizedCookies.slice(i, i + BATCH_SIZE);

        // Dedupe within batch: keep cookie with latest expiry for each unique key
        const cookiesByKey = new Map<string, any>();
        let dupCount = 0;
        for (const cookie of batch) {
          const uniqueKey = `${cookie.domain}|${cookie.name}|${cookie.path}|${cookie.top_frame_site_key || ''}`;
          const existing = cookiesByKey.get(uniqueKey);
          if (existing) {
            dupCount++;
            // Keep the one with later expiry (or the new one if expiry is null/0)
            const existingExpiry = BigInt(existing.expires_utc || 0);
            const newExpiry = BigInt(cookie.expires_utc || 0);
            if (newExpiry > existingExpiry) {
              console.log(`[Integrations] Deduping cookie ${uniqueKey}: keeping expiry ${newExpiry} over ${existingExpiry}`);
              cookiesByKey.set(uniqueKey, cookie);
            }
          } else {
            cookiesByKey.set(uniqueKey, cookie);
          }
        }

        // Use deduped batch
        const dedupedBatch = Array.from(cookiesByKey.values());
        if (dupCount > 0) {
          console.log(`[Integrations] Deduped batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} -> ${dedupedBatch.length} cookies (${dupCount} duplicates removed, kept latest expiry)`);
        }

        // Build VALUES clause for batch upsert (19 columns)
        const values = dedupedBatch.map((_, idx) => {
          const base = idx * 19;
          return `(gen_random_uuid(), $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}::bigint, $${base + 7}::boolean, $${base + 8}::boolean, $${base + 9}, NOW(), $${base + 10}::bigint, $${base + 11}, $${base + 12}::bigint, $${base + 13}::boolean, $${base + 14}::boolean, $${base + 15}::int, $${base + 16}::int, $${base + 17}::int, $${base + 18}::int, $${base + 19}::bigint)`;
        }).join(', ');

        // Flatten params (19 values per cookie)
        const params: (string | number | bigint | boolean | null)[] = [];
        for (const cookie of dedupedBatch) {
          params.push(
            userId,
            cookie.domain,
            cookie.name,
            cookie.path,
            cookie.value,
            cookie.expires_utc ? BigInt(cookie.expires_utc) : null,
            cookie.is_secure ?? false,
            cookie.is_httponly ?? false,
            browser,
            // New fields
            cookie.creation_utc ? BigInt(cookie.creation_utc) : null,
            cookie.top_frame_site_key || null,
            cookie.last_access_utc ? BigInt(cookie.last_access_utc) : null,
            cookie.has_expires ?? true,
            cookie.is_persistent ?? true,
            cookie.priority ?? 1,
            cookie.samesite ?? -1,
            cookie.source_scheme ?? 0,
            cookie.source_port ?? -1,
            cookie.last_update_utc ? BigInt(cookie.last_update_utc) : null
          );
        }

        // Upsert with conditional update: only update if incoming expiresUtc is greater
        // Unique key now includes topFrameSiteKey for partitioned cookies (CHIPS)
        // If both are null, or existing is greater, keep existing
        await prisma.$executeRawUnsafe(`
          INSERT INTO "Cookie" (id, "userId", domain, name, path, value, "expiresUtc", "isSecure", "isHttpOnly", "browserSource", "syncedAt", "creationUtc", "topFrameSiteKey", "lastAccessUtc", "hasExpires", "isPersistent", priority, "sameSite", "sourceScheme", "sourcePort", "lastUpdateUtc")
          VALUES ${values}
          ON CONFLICT ("userId", domain, name, path, "topFrameSiteKey") DO UPDATE SET
            value = EXCLUDED.value,
            "expiresUtc" = EXCLUDED."expiresUtc",
            "isSecure" = EXCLUDED."isSecure",
            "isHttpOnly" = EXCLUDED."isHttpOnly",
            "browserSource" = EXCLUDED."browserSource",
            "syncedAt" = NOW(),
            "creationUtc" = EXCLUDED."creationUtc",
            "lastAccessUtc" = EXCLUDED."lastAccessUtc",
            "hasExpires" = EXCLUDED."hasExpires",
            "isPersistent" = EXCLUDED."isPersistent",
            priority = EXCLUDED.priority,
            "sameSite" = EXCLUDED."sameSite",
            "sourceScheme" = EXCLUDED."sourceScheme",
            "sourcePort" = EXCLUDED."sourcePort",
            "lastUpdateUtc" = EXCLUDED."lastUpdateUtc"
          WHERE
            -- Update if incoming expires later, or if existing has no expiry but incoming does
            EXCLUDED."expiresUtc" > COALESCE("Cookie"."expiresUtc", 0)
            OR (EXCLUDED."expiresUtc" IS NOT NULL AND "Cookie"."expiresUtc" IS NULL)
        `, ...params);

        processedCount += dedupedBatch.length;
      }

      // Calculate how many were actually inserted vs updated (for conflict visibility)
      const countAfter = await prisma.cookie.count({ where: { userId } });
      const newlyInserted = countAfter - countBefore;
      const conflictsResolved = processedCount - newlyInserted;

      console.log(
        `[Integrations] ✅ Processed ${processedCount} ${browser} cookies for user ${userId}: ` +
        `${newlyInserted} new, ${conflictsResolved} conflicts (kept cookie with later expiry)`
      );
    }

    return res.json({
      message: 'Cookies uploaded successfully',
      cookieCount: sanitizedCookies.length,
      integration: {
        id: integration.id,
        name: integration.name,
        status: integration.status,
      },
    });
  } catch (error) {
    console.error('Error uploading cookies:', error);
    return res.status(500).json({
      error: 'Failed to upload cookies',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/localStorage/upload
 *
 * Upload encrypted Chrome localStorage batch from the Mac app.
 * Directly bulk-upserts all origins in the batch to LocalStorageOrigin table.
 * No staging table, no finalize step needed.
 *
 * Payload: { byOrigin, hashes, batchIndex, totalBatches, entryCount, originCount }
 */
router.post('/localStorage/upload', authenticate, upload.none() as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { data, iv, key, compressed } = req.body;

    if (!data || !iv || !key) {
      return res.status(400).json({
        error: 'Missing required fields: data, iv, key',
      });
    }

    // Decrypt the AES-256-CBC encrypted payload
    let localStorageData: {
      byOrigin: Record<string, { key: string; value: string }[]>;
      hashes: Record<string, string>;
      batchIndex: number;
      totalBatches: number;
      entryCount: number;
      originCount: number;
    };
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(key, 'hex'),
        Buffer.from(iv, 'hex')
      );

      const decryptedBuffer = Buffer.concat([
        decipher.update(Buffer.from(data, 'hex')),
        decipher.final(),
      ]);

      let jsonString: string;
      if (compressed === 'true') {
        const zlib = await import('zlib');
        const { promisify } = await import('util');
        const gunzip = promisify(zlib.gunzip);
        const decompressed = await gunzip(decryptedBuffer);
        jsonString = decompressed.toString('utf8');
      } else {
        jsonString = decryptedBuffer.toString('utf8');
      }

      localStorageData = JSON.parse(jsonString);
    } catch (decryptError) {
      console.error('[Integrations] localStorage decryption/decompression failed:', decryptError);
      return res.status(400).json({
        error: 'Failed to decrypt localStorage payload',
      });
    }

    if (!localStorageData.byOrigin || typeof localStorageData.byOrigin !== 'object') {
      return res.status(400).json({
        error: 'Invalid localStorage payload: expected byOrigin object',
      });
    }

    const batchInfo = ` (batch ${localStorageData.batchIndex + 1}/${localStorageData.totalBatches})`;

    // Sanitize values: remove null bytes and fix malformed Unicode that PostgreSQL can't store
    const sanitizeString = (str: string): string => {
      if (typeof str !== 'string') return str;
      // Remove null bytes and control characters
      let sanitized = str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
      // Remove orphan Unicode surrogates character by character
      // High surrogates: 0xD800-0xDBFF, Low surrogates: 0xDC00-0xDFFF
      const chars = [...sanitized];
      const filtered: string[] = [];
      for (let i = 0; i < chars.length; i++) {
        const code = chars[i].charCodeAt(0);
        if (code >= 0xD800 && code <= 0xDBFF) {
          // High surrogate - keep only if followed by low surrogate
          const nextCode = chars[i + 1]?.charCodeAt(0);
          if (nextCode >= 0xDC00 && nextCode <= 0xDFFF) {
            filtered.push(chars[i], chars[i + 1]);
            i++; // Skip the low surrogate we just added
          }
          // Otherwise drop the orphan high surrogate
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
          // Low surrogate without preceding high - drop it
        } else {
          filtered.push(chars[i]);
        }
      }
      return filtered.join('');
    };

    const sanitizedByOrigin: Record<string, { key: string; value: string }[]> = {};
    let batchEntryCount = 0;

    for (const [origin, entries] of Object.entries(localStorageData.byOrigin)) {
      const sanitizedOrigin = sanitizeString(origin);
      sanitizedByOrigin[sanitizedOrigin] = entries.map((entry: { key: string; value: string }) => ({
        key: sanitizeString(entry.key),
        value: sanitizeString(entry.value),
      })).filter((entry: { key: string; value: string }) => entry.key && entry.value);
      batchEntryCount += sanitizedByOrigin[sanitizedOrigin].length;
    }

    const batchOriginCount = Object.keys(sanitizedByOrigin).length;

    console.log(
      `[Integrations] Received${batchInfo} ${localStorageData.entryCount} localStorage entries from ${localStorageData.originCount} origins, ${batchEntryCount} after sanitization for user ${userId}`
    );

    // Bulk upsert all origins in this batch using raw SQL
    const origins = Object.keys(sanitizedByOrigin);
    if (origins.length > 0) {
      // Build VALUES clause for bulk upsert
      const values = origins.map((origin, i) => {
        const entries = sanitizedByOrigin[origin];
        const hash = localStorageData.hashes[origin] || '';
        return `(gen_random_uuid(), $${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}::jsonb, $${i * 4 + 4}, NOW())`;
      }).join(', ');

      // Flatten params: [userId, origin, entries, hash, userId, origin, entries, hash, ...]
      const params: (string | object)[] = [];
      for (const origin of origins) {
        params.push(userId, origin, JSON.stringify(sanitizedByOrigin[origin]), localStorageData.hashes[origin] || '');
      }

      await prisma.$executeRawUnsafe(`
        INSERT INTO "LocalStorageOrigin" (id, "userId", origin, entries, hash, "updatedAt")
        VALUES ${values}
        ON CONFLICT ("userId", origin) DO UPDATE SET
          entries = EXCLUDED.entries,
          hash = EXCLUDED.hash,
          "updatedAt" = NOW()
        WHERE "LocalStorageOrigin".hash IS DISTINCT FROM EXCLUDED.hash
      `, ...params);
    }

    console.log(`[Integrations] ✅ Upserted${batchInfo} ${batchOriginCount} origins for user ${userId}`);

    return res.json({
      message: 'Batch uploaded',
      batchIndex: localStorageData.batchIndex,
      totalBatches: localStorageData.totalBatches,
      entryCount: batchEntryCount,
      originCount: batchOriginCount,
    });
  } catch (error) {
    console.error('Error uploading localStorage batch:', error);
    return res.status(500).json({
      error: 'Failed to upload localStorage batch',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/integrations/fingerprint/upload
 *
 * Upload browser fingerprint data from the Mac app.
 * Receives AES-256-CBC encrypted payload with iv and key.
 */
router.post('/fingerprint/upload', authenticate, upload.none() as any, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { data, iv, key } = req.body;

    if (!data || !iv || !key) {
      return res.status(400).json({
        error: 'Missing required fields: data, iv, key',
      });
    }

    // Decrypt the AES-256-CBC encrypted payload
    let fingerprint: any;
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from(key, 'hex'),
        Buffer.from(iv, 'hex')
      );
      let decrypted = decipher.update(data, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      fingerprint = JSON.parse(decrypted);
    } catch (decryptError) {
      console.error('[Integrations] Fingerprint decryption failed:', decryptError);
      return res.status(400).json({
        error: 'Failed to decrypt fingerprint payload',
      });
    }

    // Validate fingerprint structure
    if (!fingerprint || !fingerprint.navigator || !fingerprint.screen) {
      return res.status(400).json({
        error: 'Invalid fingerprint payload: missing required fields',
      });
    }

    console.log(
      `[Integrations] Received fingerprint for user ${userId}: UA=${fingerprint.navigator?.userAgent?.substring(0, 50)}...`
    );

    // Store fingerprint in Integration.config
    const integration = await prisma.integration.upsert({
      where: {
        userId_name: {
          userId,
          name: 'browser_fingerprint',
        },
      },
      create: {
        userId,
        name: 'browser_fingerprint',
        type: IntegrationType.DATA_SOURCE,
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          fingerprint,
          uploadedAt: new Date().toISOString(),
        },
      },
      update: {
        status: IntegrationStatus.CONNECTED,
        isActive: true,
        lastSyncAt: new Date(),
        lastSuccessfulSyncAt: new Date(),
        config: {
          fingerprint,
          uploadedAt: new Date().toISOString(),
        },
      },
    });

    console.log(`[Integrations] ✅ Stored fingerprint for user ${userId}`);

    return res.json({
      message: 'Fingerprint uploaded successfully',
      integration: {
        id: integration.id,
        name: integration.name,
        status: integration.status,
      },
    });
  } catch (error) {
    console.error('Error uploading fingerprint:', error);
    return res.status(500).json({
      error: 'Failed to upload fingerprint',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Refresh Gmail access token using refresh token
 */
async function refreshGmailToken(credential: {
  id: string;
  refreshToken: string | null;
}): Promise<string | null> {
  if (!credential.refreshToken) {
    return null;
  }

  const config = EMAIL_PROVIDER_CONFIG.gmail;
  if (!config.clientId || !config.clientSecret) {
    console.error('[Gmail] Missing client ID or secret for token refresh');
    return null;
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credential.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    });

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const json = (await response.json()) as Record<string, any>;
    if (!response.ok || !json.access_token) {
      console.error('[Gmail] Token refresh failed:', json.error_description || json.error);
      return null;
    }

    // Update credential with new access token
    const expiresAt = json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null;

    await prisma.emailIntegrationCredential.update({
      where: { id: credential.id },
      data: {
        accessToken: json.access_token,
        expiresAt,
        // Google may return a new refresh token
        ...(json.refresh_token && { refreshToken: json.refresh_token }),
      },
    });

    return json.access_token as string;
  } catch (error) {
    console.error('[Gmail] Error refreshing token:', error);
    return null;
  }
}

/**
 * Build RFC 2822 formatted email message
 */
function buildRawEmail(params: {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  body: string;
}): string {
  const lines: string[] = [];
  lines.push(`From: ${params.from}`);
  lines.push(`To: ${params.to}`);
  if (params.cc) {
    lines.push(`Cc: ${params.cc}`);
  }
  lines.push(`Subject: ${params.subject}`);
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('');
  lines.push(params.body);

  const rawMessage = lines.join('\r\n');
  // Gmail API requires base64url encoding
  return Buffer.from(rawMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * POST /api/integrations/email/send
 *
 * Send an email via the user's connected Gmail account
 */
router.post('/email/send', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { to, subject, body, cc, user_id } = req.body;
    // For internal calls (API key), accept user_id from body
    // For user calls (JWT), extract from token
    const userId = req.isInternal ? user_id : req.user!.id;

    if (!userId) {
      return res.status(401).json({ 
        error: 'Unauthorized: user_id required for internal auth' 
      });
    }

    // Validate required fields
    if (!to || typeof to !== 'string') {
      return res.status(400).json({ error: 'Missing required field: to' });
    }
    if (!subject || typeof subject !== 'string') {
      return res.status(400).json({ error: 'Missing required field: subject' });
    }
    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: 'Missing required field: body' });
    }

    // Check if user has Gmail credentials - find the first one with a valid access token
    // TODO: In the future, could accept an optional email parameter to select a specific account
    const credential = await prisma.emailIntegrationCredential.findFirst({
      where: {
        userId,
        provider: EmailProvider.GMAIL,
        accessToken: { not: null },
      },
      include: {
        integration: true,
      },
      orderBy: {
        updatedAt: 'desc', // Use most recently updated credential
      },
    });

    if (!credential || !credential.accessToken) {
      return res.status(400).json({
        error: 'Gmail not connected',
        message:
          'Connect your Gmail in order to allow Rose to send emails on your behalf. To connect your Gmail click on the hamburger icon > Integrations > Connect Gmail',
      });
    }

    // Check if token is expired and refresh if needed
    let accessToken = credential.accessToken;
    const isExpired = credential.expiresAt && new Date(credential.expiresAt) <= new Date();

    if (isExpired) {
      console.log(`[Gmail] Access token expired for user ${userId}, refreshing...`);
      const newToken = await refreshGmailToken({
        id: credential.id,
        refreshToken: credential.refreshToken,
      });

      if (!newToken) {
        return res.status(400).json({
          error: 'Gmail token expired',
          message:
            'Your Gmail connection has expired. Please reconnect your Gmail by clicking on the hamburger icon > Integrations > Connect Gmail',
        });
      }
      accessToken = newToken;
    }

    // Get sender email from credential (preferred) or integration config (fallback)
    const integrationConfig = (credential.integration?.config as Record<string, unknown>) || {};
    const senderEmail = credential.email || (integrationConfig.connectedEmail as string) || req.user!.email;

    if (!senderEmail) {
      return res.status(400).json({
        error: 'Unable to determine sender email address',
      });
    }

    // Build and send the email
    const rawMessage = buildRawEmail({
      from: senderEmail,
      to,
      cc,
      subject,
      body,
    });

    const gmailResponse = await fetch(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ raw: rawMessage }),
      }
    );

    if (!gmailResponse.ok) {
      const errorData = (await gmailResponse.json()) as Record<string, any>;
      console.error('[Gmail] Send email failed:', errorData);

      // Check for specific auth errors that indicate token is invalid
      if (gmailResponse.status === 401) {
        return res.status(400).json({
          error: 'Gmail authentication failed',
          message:
            'Your Gmail connection has expired. Please reconnect your Gmail by clicking on the hamburger icon > Integrations > Connect Gmail',
        });
      }

      return res.status(500).json({
        error: 'Failed to send email',
        details: errorData.error?.message || 'Unknown Gmail API error',
      });
    }

    const result = (await gmailResponse.json()) as { id: string; threadId: string };
    console.log(`[Gmail] Email sent successfully for user ${userId}, messageId: ${result.id}`);

    return res.json({
      success: true,
      messageId: result.id,
      threadId: result.threadId,
    });
  } catch (error) {
    console.error('Error sending email:', error);
    return res.status(500).json({
      error: 'Failed to send email',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * PATCH /api/integrations/:name
 *
 * Update an integration's status or config
 */
router.patch('/:name', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;
    const { status, isActive, config } = req.body;
    
    // Find existing integration
    const existing = await prisma.integration.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
    
    if (!existing) {
      return res.status(404).json({
        error: 'Integration not found',
      });
    }
    
    // Build update data
    const updateData: any = {};
    if (status !== undefined) updateData.status = status;
    if (isActive !== undefined) updateData.isActive = isActive;
    if (config !== undefined) updateData.config = config;
    
    const updated = await prisma.integration.update({
      where: { id: existing.id },
      data: updateData,
    });
    
    return res.json({ integration: updated });
  } catch (error) {
    console.error('Error updating integration:', error);
    return res.status(500).json({
      error: 'Failed to update integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * DELETE /api/integrations/:name
 * 
 * Disconnect/delete an integration
 */
router.delete('/:name', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    const { name } = req.params;
    
    const integration = await prisma.integration.findUnique({
      where: {
        userId_name: {
          userId,
          name,
        },
      },
    });
    
    if (!integration) {
      return res.status(404).json({
        error: 'Integration not found',
      });
    }
    
    await prisma.integration.delete({
      where: { id: integration.id },
    });
    
    return res.json({
      message: 'Integration deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting integration:', error);
    return res.status(500).json({
      error: 'Failed to delete integration',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;


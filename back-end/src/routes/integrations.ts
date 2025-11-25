import express, { Response } from 'express';
import { IntegrationType, IntegrationStatus, EmailProvider, Prisma } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import fs from 'fs';
import NodeCache from 'node-cache';
import { parseIMessageData, ContactWithMessages } from '../services/integrations/iMessageParser';
import { parseVcfContent, importVcfContacts } from '../services/integrations/vcfParser';
import { parseEmailZip, importEmailsToDb } from '../services/integrations/emailParser';
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
  },
});

/**
 * GET /api/integrations
 * 
 * Get all integrations for the authenticated user
 */
router.get('/', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.id;
    
    const integrations = await prisma.integration.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
    });
    
    return res.json({
      integrations,
      count: integrations.length,
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
  const localJobCache = new NodeCache({ stdTTL: 60 * 60 });
  
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

    // Initialize job in cache
    localJobCache.set(jobId, {
      status: 'processing',
      progress: 0,
      messagesProcessed: 0,
      contactsCreated: 0,
      startedAt: new Date().toISOString(),
    });

    // Parse the ZIP file
    console.log(`[Job ${jobId}] Parsing email ZIP...`);
    const emails = parseEmailZip(filePath);
    console.log(`[Job ${jobId}] Parsed ${emails.length} emails from ZIP`);

    // Import emails to database
    const result = await importEmailsToDb(userId, userEmails, emails, jobId, localJobCache);

    // Clean up file
    fs.unlinkSync(filePath);

    // Update job status
    localJobCache.set(jobId, {
      status: 'completed',
      progress: 100,
      messagesProcessed: result.messages,
      contactsCreated: result.contacts,
      completedAt: new Date().toISOString(),
    });

    return res.json({
      message: 'Emails imported successfully',
      jobId,
      emailsParsed: emails.length,
      contactsCreated: result.contacts,
      messagesImported: result.messages,
    });
  } catch (error) {
    console.error(`[Job ${jobId}] Error uploading email ZIP:`, error);

    // Update job status
    localJobCache.set(jobId, {
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });

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
        isActive: false,
      },
    });

    await prisma.emailIntegrationCredential.upsert({
      where: {
        userId_provider: {
          userId,
          provider: config.provider,
        },
      },
      create: {
        userId,
        provider: config.provider,
        integrationId: integration.id,
        pkceVerifier: codeVerifier,
        stateToken: state,
        scopes: config.scopes,
      },
      update: {
        integrationId: integration.id,
        pkceVerifier: codeVerifier,
        stateToken: state,
        accessToken: null,
        refreshToken: null,
        expiresAt: null,
        scopes: config.scopes,
      },
    });

    const authUrl = buildAuthUrl(providerKey, { state, codeChallenge });
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return res.json({ authUrl, state, expiresAt });
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

    await prisma.emailIntegrationCredential.update({
      where: { id: credential.id },
      data: {
        accessToken: tokenResult.accessToken,
        refreshToken: tokenResult.refreshToken ?? credential.refreshToken,
        expiresAt,
        scopes: tokenResult.scopes,
        metadata: mergeJson(credential.metadata ?? null, tokenResult.metadata),
        pkceVerifier: null,
        stateToken: null,
      },
    });

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
          connectedEmail: tokenResult.userEmail,
        }),
      },
    });

    const displayEmail = tokenResult.userEmail ? ` (${tokenResult.userEmail})` : '';
    return sendOAuthResultPage(res, {
      success: true,
      message: `Successfully connected ${providerKey.toUpperCase()}${displayEmail}. You can close this window.`,
    });
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
    const { contacts } = req.body as { contacts?: ContactWithMessages[] };

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
        },
      },
      update: {
        status: IntegrationStatus.SYNCING,
        config: {
          contacts: contacts.length,
          messages: totalMessages,
          uploadedAt: new Date().toISOString(),
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
        const jobCache = new NodeCache({ stdTTL: 60 * 60 });
        await parseIMessageData(userId, contacts, jobId, jobCache);

        await prisma.integration.update({
          where: { id: integration.id },
          data: {
            status: IntegrationStatus.CONNECTED,
            isActive: true,
            lastSyncAt: new Date(),
            lastSuccessfulSyncAt: new Date(),
            config: {
              ...(integration.config as Record<string, unknown>),
              contacts: contacts.length,
              messages: totalMessages,
              lastJobId: jobId,
              lastUploadedAt: new Date().toISOString(),
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


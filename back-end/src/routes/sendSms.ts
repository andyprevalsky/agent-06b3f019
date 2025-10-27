import { Router } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

interface MessageBirdResponse {
  id: string;
  [key: string]: any;
}

interface TwilioResponse {
  sid: string;
  status: string;
  [key: string]: any;
}

/**
 * Send SMS via Twilio or MessageBird
 * POST /api/send-sms
 * Auth: API Key (internal - called by agent worker)
 * 
 * Body:
 *   - phone_number: string (E.164 format, e.g., +19729777432)
 *   - message: string
 * 
 * Provider selection via SMS_PROVIDER env var (defaults to 'twilio')
 */
router.post('/', authenticate, async (req: AuthRequest, res) => {
  try {
    const { phone_number, message } = req.body;

    // Validate input
    if (!phone_number) {
      return res.status(400).json({ error: 'phone_number is required' });
    }

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    // Determine SMS provider (defaults to twilio)
    const provider = (process.env.SMS_PROVIDER || 'twilio').toLowerCase();

    if (provider === 'twilio') {
      await sendViaTwilio(phone_number, message, res);
    } else if (provider === 'messagebird') {
      await sendViaMessageBird(phone_number, message, res);
    } else {
      return res.status(500).json({ error: `Unknown SMS provider: ${provider}` });
    }

  } catch (error) {
    console.error('Error sending SMS:', error);
    res.status(500).json({ error: 'Failed to send SMS' });
  }
});

/**
 * Send SMS via Twilio
 */
async function sendViaTwilio(
  phone_number: string,
  message: string,
  res: any
) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER || '+18556958274';

  if (!accountSid || !authToken) {
    console.error('Twilio credentials not configured');
    return res.status(500).json({ error: 'Twilio not configured' });
  }

  // Create Basic Auth header
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  // Send SMS via Twilio API
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        From: fromNumber,
        To: phone_number,
        Body: message,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Twilio API error:', response.status, errorText);
    return res.status(response.status).json({
      error: `Twilio API error (${response.status})`,
      details: errorText,
    });
  }

  const result = (await response.json()) as TwilioResponse;

  console.log('✅ SMS sent via Twilio', {
    messageId: result.sid,
    phone: phone_number,
    status: result.status,
  });

  res.json({
    success: true,
    message_id: result.sid,
    phone_number: phone_number,
    provider: 'twilio',
  });
}

/**
 * Send SMS via MessageBird
 */
async function sendViaMessageBird(
  phone_number: string,
  message: string,
  res: any
) {
  const messageBirdKey = process.env.MESSAGE_BIRD_ACCESS_KEY;
  const workspaceId = process.env.MESSAGE_BIRD_WORKSPACE_ID || '2926cfbf-bd3a-4ce1-8ebb-6044753d2db8';
  const channelId = process.env.MESSAGE_BIRD_CHANNEL_ID || '186e8ea9-175c-5c01-881c-169e4fb3be15';

  if (!messageBirdKey) {
    console.error('MESSAGE_BIRD_ACCESS_KEY not configured');
    return res.status(500).json({ error: 'MessageBird not configured' });
  }

  // Send SMS via MessageBird API
  const response = await fetch(
    `https://api.bird.com/workspaces/${workspaceId}/channels/${channelId}/messages`,
    {
      method: 'POST',
      headers: {
        'Authorization': `AccessKey ${messageBirdKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        body: {
          type: 'text',
          text: {
            text: message,
          },
        },
        receiver: {
          contacts: [
            {
              identifierValue: phone_number,
              identifierKey: 'phonenumber',
            },
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('MessageBird API error:', response.status, errorText);
    return res.status(response.status).json({
      error: `MessageBird API error (${response.status})`,
      details: errorText,
    });
  }

  const result = (await response.json()) as MessageBirdResponse;

  console.log('✅ SMS sent via MessageBird', {
    messageId: result.id,
    phone: phone_number.substring(0, 4) + '****',
  });

  res.json({
    success: true,
    message_id: result.id,
    phone_number: phone_number,
    provider: 'messagebird',
  });
}

export default router;


/**
 * SMS Webhook Routes
 *
 * Handles inbound SMS from Twilio for:
 * 1. Creating new agents (messages prefixed with "new")
 * 2. Routing replies to active agent questions
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { startAgentWorkflow, getTemporalClient } from '../lib/temporal';
import { getActiveAgentForUser } from '../lib/smsQueue';
import { SMS_TEMPLATES, ROSE_SMS_NUMBER } from '../lib/smsTemplates';

const router = Router();

/**
 * Validate Twilio webhook signature
 */
function validateTwilioSignature(
  req: Request,
  authToken: string
): boolean {
  const twilioSignature = req.headers['x-twilio-signature'] as string;
  if (!twilioSignature) {
    return false;
  }

  // Build the full URL Twilio used to generate the signature
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['host'];
  const url = `${protocol}://${host}${req.originalUrl}`;

  // Build the data string from sorted POST params
  const params = req.body;
  const sortedKeys = Object.keys(params).sort();
  const dataString = url + sortedKeys.map((key) => key + params[key]).join('');

  // Calculate expected signature
  const hmac = crypto.createHmac('sha1', authToken);
  hmac.update(dataString, 'utf-8');
  const expectedSignature = hmac.digest('base64');

  return twilioSignature === expectedSignature;
}

/**
 * Generate verifier prompt for a goal
 */
function generateVerifierPrompt(goal: string): string {
  return `You are judging whether the agent has achieved the following goal: "${goal}"

Scoring Instructions:
- Return a float between 0.0 and 1.0.
- 0.0 means no progress or only explanations/plans.
- 1.0 means the goal is FULLY accomplished with verifiable proof.
- Do not award 1.0 for partial completion.
- The agent has access to tools and can solve problems through persistence and creativity.`;
}

/**
 * Build TwiML response
 */
function twimlResponse(message?: string): string {
  if (message) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  }
  return '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * POST /api/sms/inbound - Twilio webhook for inbound SMS
 *
 * Twilio sends:
 * - From: sender phone number (E.164)
 * - To: Rose's phone number
 * - Body: message text
 */
router.post('/inbound', async (req: Request, res: Response) => {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Validate Twilio signature in production
    if (authToken && process.env.NODE_ENV === 'production') {
      if (!validateTwilioSignature(req, authToken)) {
        console.error('[SMS Webhook] Invalid Twilio signature');
        return res.status(403).send('Invalid signature');
      }
    }

    const fromPhone = req.body.From as string;
    const messageBody = (req.body.Body as string || '').trim();

    console.log('[SMS Webhook] Received inbound SMS', {
      from: fromPhone?.substring(0, 7) + '****',
      bodyLength: messageBody.length,
    });

    if (!fromPhone || !messageBody) {
      return res.type('text/xml').send(twimlResponse('Invalid message format.'));
    }

    // Look up user by phone number
    const user = await prisma.user.findFirst({
      where: { phone: fromPhone },
    });

    if (!user) {
      console.log('[SMS Webhook] Unknown phone number', {
        phone: fromPhone?.substring(0, 7) + '****',
      });
      return res.type('text/xml').send(twimlResponse(SMS_TEMPLATES.unknownPhone()));
    }

    // Check if message starts with "new" (case-insensitive)
    const isNewGoal = messageBody.toLowerCase().startsWith('new');

    if (isNewGoal) {
      // Create new agent from SMS
      const goalText = messageBody.replace(/^new\s*/i, '').trim();

      if (!goalText) {
        return res.type('text/xml').send(twimlResponse(SMS_TEMPLATES.emptyGoal()));
      }

      // Create agent with SMS source
      const verifierPrompt = generateVerifierPrompt(goalText);

      const agent = await prisma.$transaction(async (tx) => {
        const newAgent = await tx.agent.create({
          data: {
            userId: user.userId,
            goal: goalText,
            source: 'SMS',
            model: 'rose-labs/rose-1-lite',
            reasoningMaxTokens: 2048,
            status: 'STARTING_UP',
          },
        });

        await tx.verifier.create({
          data: {
            agentId: newAgent.id,
            type: 'FLOAT_LLM_JUDGE',
            llmJudgePrompt: verifierPrompt,
          },
        });

        await tx.message.create({
          data: {
            agentId: newAgent.id,
            text: goalText,
            role: 'USER',
            timestamp: new Date(),
          },
        });

        return newAgent;
      });

      // Start Temporal workflow
      try {
        const workflowId = await startAgentWorkflow({
          agentId: agent.id,
          userId: user.userId,
          goal: goalText,
          model: 'rose-labs/rose-1-lite',
          reasoningMaxTokens: 2048,
          verifier: {
            type: 'FLOAT_LLM_JUDGE',
            llmJudgePrompt: verifierPrompt,
          },
          priceLimitCents: agent.priceLimitCents,
        });

        await prisma.agent.update({
          where: { id: agent.id },
          data: { temporalWorkflowId: workflowId },
        });

        console.log('[SMS Webhook] Created agent from SMS', {
          agentId: agent.id,
          workflowId,
          userId: user.userId,
        });
      } catch (error) {
        console.error('[SMS Webhook] Failed to start workflow', error);
        // Mark agent as failed
        await prisma.agent.update({
          where: { id: agent.id },
          data: { status: 'FAILED', statusMessage: 'Failed to start workflow' },
        });
        return res
          .type('text/xml')
          .send(twimlResponse('Sorry, there was an error starting your task. Please try again.'));
      }

      // Send confirmation with agent URL
      const goalPreview = goalText.length > 100 ? goalText.substring(0, 97) + '...' : goalText;
      return res.type('text/xml').send(twimlResponse(SMS_TEMPLATES.newGoalConfirmation(goalPreview, agent.id)));
    }

    // This is a reply to an existing agent question
    const activeAgent = await getActiveAgentForUser(user.userId);

    if (!activeAgent) {
      return res.type('text/xml').send(twimlResponse(SMS_TEMPLATES.noActiveQuestion()));
    }

    // Post the reply as a USER message
    await prisma.message.create({
      data: {
        agentId: activeAgent.agentId,
        text: messageBody,
        role: 'USER',
        metadata: { source: 'sms' },
      },
    });

    // Signal the workflow that a user response was received
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(activeAgent.workflowId);
      await handle.signal('receive_user_response', messageBody);
      console.log('[SMS Webhook] Signaled workflow with user response', {
        workflowId: activeAgent.workflowId,
        agentId: activeAgent.agentId,
      });
    } catch (error) {
      console.error('[SMS Webhook] Failed to signal workflow', {
        workflowId: activeAgent.workflowId,
        error,
      });
    }

    // No reply needed - agent will continue processing
    return res.type('text/xml').send(twimlResponse());
  } catch (error) {
    console.error('[SMS Webhook] Error processing inbound SMS:', error);
    return res.status(500).type('text/xml').send(twimlResponse('An error occurred.'));
  }
});

export default router;

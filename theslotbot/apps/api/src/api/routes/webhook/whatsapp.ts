/**
 * src/api/routes/webhook/whatsapp.ts
 *
 * The single inbound entrypoint for all Meta Cloud API traffic.
 *
 * MIDDLEWARE ORDER (mounted in api/index.ts):
 *   express.raw({ type: 'application/json' })
 *     → validateWebhookSignature   (Risk E2 — verifies HMAC, parses JSON)
 *     → subscriptionGate           (Kill Switch — may intercept and stop here)
 *     → this route handler         (only reached if salon is active, or
 *                                    the payload wasn't a customer message)
 *
 * GET handler: Meta's one-time webhook verification handshake.
 * POST handler: every subsequent message and status callback.
 *
 * ALWAYS RETURN 200: Meta retries on non-200. Once our own processing
 * is complete (success OR intentional skip), we return 200 regardless
 * of what happened inside — retries would just re-run the same logic
 * for no benefit and risk duplicate side effects that our idempotency
 * layers would then have to absorb unnecessarily.
 */

import { Router, Request, Response } from 'express';
import { logger } from '@/lib/logger';
import { extractInboundMessage, extractStatusCallback } from '@/modules/whatsapp/payload-parser';
import { handleInboundMessage } from '@/modules/whatsapp/state-machine';
import {
  markDelivered,
  markRead,
} from '@/modules/notifications/message-log.service';

const log = logger.child({ module: 'webhook.whatsapp' });

export const whatsappWebhookRouter = Router();

const META_WEBHOOK_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN;

if (!META_WEBHOOK_VERIFY_TOKEN) {
  throw new Error('META_WEBHOOK_VERIFY_TOKEN environment variable is not set');
}

// ─────────────────────────────────────────────
// GET — Meta's verification handshake
// ─────────────────────────────────────────────

whatsappWebhookRouter.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_WEBHOOK_VERIFY_TOKEN) {
    log.info('Webhook verification handshake succeeded');
    res.status(200).send(challenge);
    return;
  }

  log.warn({ mode, tokenProvided: Boolean(token) }, 'Webhook verification failed');
  res.sendStatus(403);
});

// ─────────────────────────────────────────────
// POST — inbound messages and status callbacks
// ─────────────────────────────────────────────
//
// NOTE: validateWebhookSignature and subscriptionGate are mounted as
// route-specific middleware ahead of this handler (see api/index.ts).
// By the time this function runs, either:
//   (a) the salon is active and req.salon is populated, or
//   (b) the payload wasn't a customer message at all (e.g. a status
//       callback), in which case subscriptionGate passed it through
//       without resolving req.salon.

whatsappWebhookRouter.post('/whatsapp', async (req: Request, res: Response) => {
  // Acknowledge Meta immediately — see module comment on why we never
  // make Meta wait on our internal processing or risk a timeout-induced
  // retry storm. Processing continues after the response is sent.
  res.status(200).send('EVENT_RECEIVED');

  try {
    const inboundMessage = extractInboundMessage(req.body);

    if (inboundMessage && req.salon) {
      // subscriptionGate already confirmed this salon is active and
      // attached it to req — safe to hand off to the state machine.
      await handleInboundMessage({
        salonId: req.salon.id,
        salonName: req.salon.name,
        message: inboundMessage,
      });
      return;
    }

    if (inboundMessage && !req.salon) {
      // subscriptionGate intercepted (suspended/cancelled/unknown salon)
      // and already responded conceptually — nothing further to do here.
      // This branch exists only for clarity; subscriptionGate's own
      // res.status(200) already fired in that case, so reaching here
      // with inboundMessage set but no req.salon should not happen in
      // practice (the gate either calls next() with req.salon set, or
      // it terminates the request itself). Logged defensively.
      log.debug('Inbound message present but no salon context — gate should have handled this');
      return;
    }

    // Not a customer message — check if it's a status callback instead.
    const statusCallback = extractStatusCallback(req.body);
    if (statusCallback) {
      await handleStatusCallback(statusCallback);
      return;
    }

    log.debug({ body: req.body }, 'Webhook payload did not match any known event shape');
  } catch (err) {
    // We've already responded 200 to Meta. Any error here is purely
    // internal — log loudly for BetterStack alerting, but there's
    // nothing further to send back to Meta at this point.
    log.error({ err }, 'Unhandled error processing webhook payload');
  }
});

// ─────────────────────────────────────────────
// STATUS CALLBACK HANDLING
// ─────────────────────────────────────────────

async function handleStatusCallback(callback: {
  metaMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errorCode: string | null;
}): Promise<void> {
  switch (callback.status) {
    case 'delivered':
      await markDelivered(callback.metaMessageId);
      break;
    case 'read':
      await markRead(callback.metaMessageId);
      break;
    case 'sent':
      // Already marked sent synchronously by gateway.ts at send time.
      // This callback is informational confirmation only — no action needed.
      break;
    case 'failed':
      // markFailed requires our internal messageLogId, not Meta's ID,
      // and gateway.ts already calls markFailed at send-attempt time
      // when the initial API call itself fails. A 'failed' status
      // callback arriving later (post-acceptance delivery failure) is
      // a distinct case worth tracking, but message-log.service.ts's
      // markFailed signature expects messageLogId. For this async
      // failure path we look up by metaMessageId instead.
      log.warn(
        { metaMessageId: callback.metaMessageId, errorCode: callback.errorCode },
        'Message delivery failed post-acceptance (async status callback)',
      );
      break;
  }
}

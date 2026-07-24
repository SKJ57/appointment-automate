/**
 * src/api/middleware/validateWebhookSignature.ts
 *
 * Risk E2 fix: Meta webhook signature validation.
 *
 * THE BUG THIS PREVENTS:
 * Meta signs every webhook POST with an X-Hub-Signature-256 header,
 * computed as HMAC-SHA256(rawRequestBody, META_APP_SECRET). Validating
 * this requires the EXACT raw bytes Meta sent — not the parsed JSON
 * object, which can serialize differently (key order, whitespace,
 * number formatting) and produce a different HMAC than what Meta computed.
 *
 * The most common way this breaks in production: mounting
 * `express.json()` globally on the app. That middleware consumes and
 * parses the request body, replacing `req.body` with a JS object and
 * leaving no way to recover the original bytes. Signature validation
 * then either fails on every request (if you try to re-stringify the
 * parsed object) or — worse — gets silently skipped because someone
 * "fixed" the constant failures by disabling the check.
 *
 * THE FIX:
 * This route uses `express.raw({ type: 'application/json' })` instead
 * of `express.json()`. That gives us `req.body` as a raw Buffer. We
 * compute the HMAC against that buffer, compare it to Meta's header,
 * and only THEN parse it as JSON for the rest of the handler chain.
 *
 * MOUNTING REQUIREMENT:
 * This middleware (and the raw body parser before it) must be mounted
 * ONLY on the webhook route, not globally. If express.json() is also
 * mounted globally elsewhere in the app, ensure the webhook route is
 * registered before that global middleware, or explicitly excluded
 * from it. See api/index.ts for the correct mounting order.
 */

import { Request, Response, NextFunction, RequestHandler } from 'express';
import crypto from 'crypto';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'validateWebhookSignature' });

const META_APP_SECRET = process.env.META_APP_SECRET;

if (!META_APP_SECRET) {
  throw new Error(
    'META_APP_SECRET environment variable is not set. ' +
      'The webhook signature middleware cannot start without it — ' +
      'this is a hard requirement, not an optional safety check.',
  );
}

/**
 * Express type augmentation: after this middleware runs successfully,
 * req.body is replaced with the parsed JSON object (same shape as if
 * express.json() had run), and req.rawBody retains the original Buffer
 * in case a downstream handler ever needs to re-verify or log it.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

/**
 * Computes HMAC-SHA256 of the raw body using the Meta App Secret and
 * compares it against the X-Hub-Signature-256 header using a
 * constant-time comparison (crypto.timingSafeEqual) to prevent
 * timing-attack signature guessing.
 */
function isValidSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = signatureHeader.slice('sha256='.length);

  const computedHmac = crypto
    .createHmac('sha256', META_APP_SECRET as string)
    .update(rawBody)
    .digest('hex');

  // Lengths must match before timingSafeEqual — it throws on mismatched
  // buffer lengths rather than returning false, which would itself leak
  // timing information about the expected signature's length.
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const computedBuffer = Buffer.from(computedHmac, 'hex');

  if (expectedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
}

/**
 * Middleware: validates the Meta webhook signature and parses the body.
 *
 * Expects to run AFTER express.raw({ type: 'application/json' }) on
 * this route only, so req.body arrives here as a Buffer.
 *
 * On success: req.body is replaced with the parsed JSON object,
 * req.rawBody retains the original Buffer, and next() is called.
 *
 * On failure: responds 403 immediately. Per Meta's webhook contract,
 * a non-200 response causes Meta to retry — that's the correct behavior
 * for a genuinely malformed/unsigned request, since we want forged
 * requests rejected outright, not silently accepted.
 */
export const validateWebhookSignature: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  if (!Buffer.isBuffer(req.body)) {
    // This indicates a mounting-order bug: some other body parser ran
    // first and consumed the raw bytes. Fail loudly — this must never
    // pass silently in any environment, since it means signature
    // validation has been effectively disabled.
    log.error(
      { contentType: req.headers['content-type'] },
      'req.body is not a raw Buffer — express.raw() did not run before this middleware. Rejecting request.',
    );
    res.status(500).json({
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Webhook body parsing misconfigured',
      },
    });
    return;
  }

  const rawBody = req.body as Buffer;
  const signatureHeader = req.headers['x-hub-signature-256'] as
    | string
    | undefined;

  if (!isValidSignature(rawBody, signatureHeader)) {
    log.warn(
      {
        hasSignatureHeader: Boolean(signatureHeader),
        ip: req.ip,
      },
      'Webhook signature validation failed — rejecting request',
    );
    res.status(403).json({
      success: false,
      error: {
        code: 'INVALID_WEBHOOK_SIGNATURE',
        message: 'Signature validation failed',
      },
    });
    return;
  }

  // Signature verified. Now safe to parse and attach for downstream use.
  req.rawBody = rawBody;
  try {
    req.body = JSON.parse(rawBody.toString('utf-8'));
  } catch (err) {
    log.warn({ err }, 'Webhook body failed JSON parsing after signature check passed');
    res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Malformed JSON body',
      },
    });
    return;
  }

  next();
};

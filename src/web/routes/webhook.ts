import type { FastifyInstance } from 'fastify';
import type { ServerOptions } from '../server.js';
import type { AppContext } from '../../services/context.js';
import { handleInboundSms } from '../../services/inboundSms.js';
import { validateTwilioSignature } from '../../sms/twilio.js';
import { toE164 } from '../../domain/phone.js';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio inbound-message webhook. Configure the number's "A message comes in" URL as
 *   POST {PUBLIC_BASE_URL}/sms/inbound
 * Replies are sent through the REST API (outbox), so the TwiML response is empty.
 */
export function registerWebhook(app: FastifyInstance, ctx: AppContext, env: ServerOptions['env']) {
  app.post('/sms/inbound', async (req, reply) => {
    const params = Object.fromEntries(
      Object.entries((req.body ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v ?? '')]),
    );

    if (env.TWILIO_VALIDATE_SIGNATURE) {
      if (!env.TWILIO_AUTH_TOKEN) {
        ctx.log.error('Inbound SMS rejected: TWILIO_AUTH_TOKEN not set (or set TWILIO_VALIDATE_SIGNATURE=false for local testing)');
        return reply.code(403).send('Signature validation not configured');
      }
      const url = env.PUBLIC_BASE_URL.replace(/\/$/, '') + req.url;
      const sig = req.headers['x-twilio-signature'];
      if (!validateTwilioSignature(env.TWILIO_AUTH_TOKEN, typeof sig === 'string' ? sig : undefined, url, params)) {
        ctx.log.warn(`Inbound SMS rejected: bad Twilio signature for ${url}`);
        return reply.code(403).send('Invalid signature');
      }
    }

    const sid = params.MessageSid || params.SmsSid;
    const from = toE164(params.From ?? '', ctx.defaultRegion);
    if (!sid || !from) return reply.code(400).send('Missing MessageSid or From');

    await handleInboundSms(ctx, { from, body: params.Body ?? '', providerSid: sid });
    return reply.type('text/xml').send(EMPTY_TWIML);
  });
}

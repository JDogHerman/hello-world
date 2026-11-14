import twilio from 'twilio';
import type { OutboundSms, SendResult, SmsProvider } from './SmsProvider.js';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  fromNumber?: string;
  messagingServiceSid?: string;
  /** Optional delivery-status callback URL. */
  statusCallback?: string;
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  private readonly client: twilio.Twilio;

  constructor(private readonly opts: TwilioOptions) {
    this.client = twilio(opts.accountSid, opts.authToken);
  }

  async send(msg: OutboundSms): Promise<SendResult> {
    const res = await this.client.messages.create({
      to: msg.to,
      body: msg.body,
      ...(this.opts.messagingServiceSid
        ? { messagingServiceSid: this.opts.messagingServiceSid }
        : { from: this.opts.fromNumber! }),
      ...(this.opts.statusCallback ? { statusCallback: this.opts.statusCallback } : {}),
    });
    return { providerSid: res.sid };
  }
}

/** Verifies the X-Twilio-Signature header for a form-encoded webhook POST. */
export function validateTwilioSignature(
  authToken: string,
  signature: string | undefined,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

import type { Env } from '../env.js';
import { FakeSmsProvider } from './fake.js';
import type { SmsProvider } from './SmsProvider.js';
import { TwilioSmsProvider } from './twilio.js';

export function createSmsProvider(env: Env): SmsProvider {
  if (env.SMS_PROVIDER === 'twilio') {
    return new TwilioSmsProvider({
      accountSid: env.TWILIO_ACCOUNT_SID!,
      authToken: env.TWILIO_AUTH_TOKEN!,
      fromNumber: env.TWILIO_FROM_NUMBER,
      messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
    });
  }
  return new FakeSmsProvider();
}

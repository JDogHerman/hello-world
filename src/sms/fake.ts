import type { OutboundSms, SendResult, SmsProvider } from './SmsProvider.js';

/**
 * Development/test provider: prints each text to the console and keeps it in memory.
 * Inbound replies are simulated via the "Simulate reply" form in the UI (dev only)
 * or by calling the inbound handler directly in tests.
 */
export class FakeSmsProvider implements SmsProvider {
  readonly name = 'console';
  readonly sent: (OutboundSms & { sid: string; at: Date })[] = [];
  private seq = 0;
  /** Set to make the next N sends fail (for retry tests). */
  failNext = 0;

  constructor(private readonly opts: { silent?: boolean } = {}) {}

  async send(msg: OutboundSms): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('FakeSmsProvider: simulated failure');
    }
    const sid = `FAKE${String(++this.seq).padStart(8, '0')}`;
    this.sent.push({ ...msg, sid, at: new Date() });
    if (!this.opts.silent) console.log(`\x1b[36m[SMS → ${msg.to}]\x1b[0m ${msg.body}`);
    return { providerSid: sid };
  }

  to(phone: string): string[] {
    return this.sent.filter((m) => m.to === phone).map((m) => m.body);
  }

  last(phone: string): string | undefined {
    return this.to(phone).at(-1);
  }

  clear(): void {
    this.sent.length = 0;
  }
}

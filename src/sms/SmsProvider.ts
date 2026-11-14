export interface OutboundSms {
  to: string; // E.164
  body: string;
}

export interface SendResult {
  providerSid: string;
}

/** Swappable SMS transport. Inbound messages arrive via the webhook route, not this interface. */
export interface SmsProvider {
  readonly name: string;
  send(msg: OutboundSms): Promise<SendResult>;
}

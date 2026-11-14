import { DateTime } from 'luxon';

export interface CallInfo {
  localName: string;
  jobType: string;
  venue: string;
  skill: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}

const day = (at: Date, tz: string) => DateTime.fromJSDate(at, { zone: tz }).toFormat('ccc M/d');
const time = (at: Date, tz: string) => DateTime.fromJSDate(at, { zone: tz }).toFormat('h:mm a');
const tag = (c: { localName: string }) => `[${c.localName}]`;

export function offerText(c: CallInfo, code: string, sentAt: Date, expiresAt: Date, windowMinutes: number): string {
  const straight = expiresAt.getTime() - sentAt.getTime() === windowMinutes * 60_000;
  const expiry = straight
    ? `Expires in ${windowMinutes} min.`
    : `Expires ${day(expiresAt, c.timezone)} ${time(expiresAt, c.timezone)}.`;
  return (
    `${tag(c)} Work call: ${c.jobType} at ${c.venue}, ${day(c.startsAt, c.timezone)}, ${time(c.startsAt, c.timezone)}, ` +
    `Position: ${c.skill}. Reply YES ${code} to accept or NO ${code} to decline. ${expiry}`
  );
}

export function confirmText(c: CallInfo, code: string): string {
  return (
    `${tag(c)} Confirmed (${code}): ${c.skill}, ${c.jobType} at ${c.venue}, ${day(c.startsAt, c.timezone)} ` +
    `${time(c.startsAt, c.timezone)}–${time(c.endsAt, c.timezone)} (est). Contact your Steward if plans change.`
  );
}

export function declineAckText(c: CallInfo, code: string): string {
  return `${tag(c)} Got it — you declined offer ${code}. Thanks.`;
}

export function filledText(c: CallInfo, code: string): string {
  return `${tag(c)} Offer ${code} (${c.skill}, ${c.jobType} ${day(c.startsAt, c.timezone)}) has been filled. No action needed.`;
}

export function withdrawnText(c: CallInfo, code: string): string {
  return `${tag(c)} Offer ${code} (${c.skill}, ${c.jobType} ${day(c.startsAt, c.timezone)}) has been withdrawn. No action needed.`;
}

export function expiredText(c: CallInfo, code: string): string {
  return `${tag(c)} Sorry, offer ${code} (${c.skill}, ${c.jobType} ${day(c.startsAt, c.timezone)}) has expired.`;
}

export function conflictText(c: CallInfo, code: string): string {
  return `${tag(c)} Sorry, offer ${code} conflicts with another call you have accepted, so it could not be confirmed.`;
}

export function alreadyAcceptedText(c: CallInfo, code: string): string {
  return `${tag(c)} You're already confirmed for offer ${code}. To cancel, contact your Steward.`;
}

export function alreadyDeclinedText(c: CallInfo, code: string): string {
  return `${tag(c)} You already declined offer ${code}. Contact your Steward if you still want it.`;
}

export function callCancelledText(c: CallInfo): string {
  return `${tag(c)} CANCELLED: ${c.jobType} at ${c.venue}, ${day(c.startsAt, c.timezone)} ${time(c.startsAt, c.timezone)}. You are released from this call.`;
}

export function releasedText(c: CallInfo): string {
  return `${tag(c)} You have been released from ${c.skill}, ${c.jobType} at ${c.venue}, ${day(c.startsAt, c.timezone)}. Contact your Steward with questions.`;
}

export function helpText(localName: string, openCodes: string[] = []): string {
  const open = openCodes.length ? ` Your open offers: ${openCodes.join(', ')}.` : '';
  return `[${localName}] Reply YES <code> to accept or NO <code> to decline a work call (e.g. YES 4821).${open} Reply STOP to opt out.`;
}

export function noOpenOffersText(localName: string): string {
  return `[${localName}] You have no open work-call offers right now.`;
}

export function unknownCodeText(localName: string, code: string, openCodes: string[]): string {
  const open = openCodes.length ? ` Your open offers: ${openCodes.join(', ')}.` : '';
  return `[${localName}] We couldn't find offer ${code}.${open}`;
}

export function exhaustedStewardText(localName: string, c: CallInfo, filled: number, qty: number): string {
  return `[${localName}] ALERT: ${c.skill} for ${c.jobType} at ${c.venue} ${day(c.startsAt, c.timezone)} ran out of candidates (${filled}/${qty} filled).`;
}

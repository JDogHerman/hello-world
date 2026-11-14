import { describe, expect, it } from 'vitest';
import * as T from '../../src/sms/templates.js';

// GSM 03.38 basic character set (+ extension chars). Any other character forces UCS-2,
// which cuts a segment from 160 to 70 characters and roughly triples the cost.
const GSM = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà^{}\\[~]|€',
);
const segments = (s: string) => (s.length <= 160 ? 1 : Math.ceil(s.length / 153));

const c: T.CallInfo = {
  localName: 'IATSE 48 Akron/Canton',
  jobType: 'Load-in',
  venue: 'E.J. Thomas Performing Arts Hall',
  skill: 'Rigging',
  startsAt: new Date('2026-11-21T13:00:00Z'),
  endsAt: new Date('2026-11-21T21:00:00Z'),
  timezone: 'America/New_York',
};
const sent = new Date('2026-11-20T15:00:00Z');

const all: [string, string][] = [
  ['offer', T.offerText(c, '4821', sent, new Date(sent.getTime() + 3600e3), 60)],
  ['offer (paused)', T.offerText(c, '4821', sent, new Date('2026-11-21T13:30:00Z'), 60)],
  ['confirm', T.confirmText(c, '4821')],
  ['decline', T.declineAckText(c, '4821')],
  ['filled', T.filledText(c, '4821')],
  ['withdrawn', T.withdrawnText(c, '4821')],
  ['expired', T.expiredText(c, '4821')],
  ['conflict', T.conflictText(c, '4821')],
  ['already accepted', T.alreadyAcceptedText(c, '4821')],
  ['already declined', T.alreadyDeclinedText(c, '4821')],
  ['call cancelled', T.callCancelledText(c)],
  ['released', T.releasedText(c)],
  ['help', T.helpText(c.localName, ['4821', '1234'])],
  ['no offers', T.noOpenOffersText(c.localName)],
  ['unknown code', T.unknownCodeText(c.localName, '9999', ['4821'])],
  ['steward alert', T.exhaustedStewardText(c.localName, c, 1, 2)],
];

describe('SMS templates', () => {
  it.each(all)('%s uses only GSM-7 characters and fits in 2 segments', (_name, text) => {
    expect([...text].filter((ch) => !GSM.has(ch))).toEqual([]);
    expect(segments(text)).toBeLessThanOrEqual(2);
  });

  it('prefixes every text with the union name', () => {
    for (const [, text] of all) expect(text.startsWith('[IATSE 48 Akron/Canton] ')).toBe(true);
  });
});

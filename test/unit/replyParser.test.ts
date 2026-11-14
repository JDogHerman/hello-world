import { describe, expect, it } from 'vitest';
import { generateOfferCode, parseReply } from '../../src/domain/replyParser.js';
import { toE164 } from '../../src/domain/phone.js';
import { jobWindow } from '../../src/domain/time.js';

describe('parseReply', () => {
  it.each([
    ['YES 4821', { kind: 'accept', code: '4821' }],
    ['yes 4821', { kind: 'accept', code: '4821' }],
    ['  Yes, 4821! ', { kind: 'accept', code: '4821' }],
    ['4821 yes', { kind: 'accept', code: '4821' }],
    ['Y4821', { kind: 'unknown' }],
    ['y 4821', { kind: 'accept', code: '4821' }],
    ['YES', { kind: 'accept', code: null }],
    ['NO 4821', { kind: 'decline', code: '4821' }],
    ['no', { kind: 'decline', code: null }],
    ['Decline 1234', { kind: 'decline', code: '1234' }],
    ['STOP', { kind: 'opt_out' }],
    ['stop', { kind: 'opt_out' }],
    ['Unsubscribe', { kind: 'opt_out' }],
    ['START', { kind: 'opt_in' }],
    ['unstop', { kind: 'opt_in' }],
    ['HELP', { kind: 'help' }],
    ['yes 123', { kind: 'unknown' }],
    ['yes 4821 1234', { kind: 'unknown' }],
    ['yes no 4821', { kind: 'unknown' }],
    ['maybe 4821', { kind: 'unknown' }],
    ['', { kind: 'unknown' }],
    ['please stop texting me', { kind: 'unknown' }],
  ])('%j', (body, expected) => {
    expect(parseReply(body)).toEqual(expected);
  });
});

describe('generateOfferCode', () => {
  it('produces 4 digits and avoids taken codes', () => {
    const seq = [0.0, 0.0, 0.5];
    let i = 0;
    const code = generateOfferCode(new Set(['1000']), () => seq[i++]);
    expect(code).toBe('5500');
  });
});

describe('toE164', () => {
  it.each([
    ['(212) 555-0123', '+12125550123'],
    ['(012) 456-1111', null],
    ['(202) 456-1111', '+12024561111'],
    ['202.456.1111', '+12024561111'],
    ['+44 20 7946 0958', '+442079460958'],
    ['12345', null],
    ['', null],
  ])('%s -> %s', (input, expected) => {
    expect(toE164(input, 'US')).toBe(expected);
  });
});

describe('jobWindow', () => {
  it('rolls an end time before the start into the next day', () => {
    const { startsAt, endsAt } = jobWindow('2026-11-21', '19:00', '01:00', 'America/New_York');
    expect(startsAt.toISOString()).toBe('2026-11-22T00:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2026-11-22T06:00:00.000Z');
  });
});

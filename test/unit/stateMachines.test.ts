import { describe, expect, it } from 'vitest';
import {
  canListTransition,
  canOfferTransition,
  IllegalTransitionError,
  nextListStatus,
  nextOfferStatus,
  type OfferEvent,
} from '../../src/domain/stateMachines.js';
import type { OfferStatus } from '../../src/db/types.js';

describe('offer state machine', () => {
  it.each<[OfferStatus, OfferEvent, OfferStatus]>([
    ['queued', 'send', 'sent'],
    ['queued', 'cancel', 'cancelled'],
    ['sent', 'accept', 'accepted'],
    ['sent', 'decline', 'declined'],
    ['sent', 'expire', 'expired'],
    ['sent', 'cancel', 'cancelled'],
  ])('%s --%s--> %s', (from, ev, to) => {
    expect(nextOfferStatus(from, ev)).toBe(to);
  });

  it('cannot accept, decline or expire a queued offer (worker has not received it)', () => {
    for (const ev of ['accept', 'decline', 'expire'] as const) {
      expect(() => nextOfferStatus('queued', ev)).toThrow(IllegalTransitionError);
    }
  });

  it('terminal states accept no events', () => {
    const events: OfferEvent[] = ['send', 'accept', 'decline', 'expire', 'cancel'];
    for (const s of ['accepted', 'declined', 'expired', 'cancelled'] as const) {
      for (const ev of events) expect(canOfferTransition(s, ev)).toBe(false);
    }
  });

  it('cannot send twice', () => {
    expect(() => nextOfferStatus('sent', 'send')).toThrow(/cannot "send" from "sent"/);
  });
});

describe('candidate list state machine', () => {
  it('follows the happy path', () => {
    let s = nextListStatus('draft', 'submit');
    expect(s).toBe('pending_approval');
    s = nextListStatus(s, 'approve');
    expect(s).toBe('approved');
    s = nextListStatus(s, 'activate');
    expect(s).toBe('active');
    expect(nextListStatus(s, 'fill')).toBe('filled');
    expect(nextListStatus(s, 'exhaust')).toBe('exhausted');
  });

  it('allows approving directly from draft', () => {
    expect(nextListStatus('draft', 'approve')).toBe('approved');
  });

  it('cannot activate (send SMS) before approval', () => {
    expect(canListTransition('draft', 'activate')).toBe(false);
    expect(canListTransition('pending_approval', 'activate')).toBe(false);
  });

  it('cannot regenerate once approved', () => {
    for (const s of ['approved', 'active', 'filled', 'exhausted'] as const) {
      expect(canListTransition(s, 'regenerate')).toBe(false);
    }
  });

  it('reopens an exhausted list when candidates are added', () => {
    expect(nextListStatus('exhausted', 'reopen')).toBe('active');
  });
});

import type { ListStatus, OfferStatus } from '../db/types.js';

export class IllegalTransitionError extends Error {
  constructor(kind: string, from: string, event: string) {
    super(`Illegal ${kind} transition: cannot "${event}" from "${from}"`);
    this.name = 'IllegalTransitionError';
  }
}

// ---------------------------------------------------------------- Offer

export type OfferEvent = 'send' | 'accept' | 'decline' | 'expire' | 'cancel';

/**
 *   queued ──send──► sent ──accept──► accepted
 *     │               ├──decline──► declined
 *     │               ├──expire───► expired
 *     └──cancel──►    └──cancel───► cancelled
 *
 * `queued` = created but held (quiet hours); its reply countdown has not started.
 */
const OFFER_TRANSITIONS: Record<OfferStatus, Partial<Record<OfferEvent, OfferStatus>>> = {
  queued: { send: 'sent', cancel: 'cancelled' },
  sent: { accept: 'accepted', decline: 'declined', expire: 'expired', cancel: 'cancelled' },
  accepted: {},
  declined: {},
  expired: {},
  cancelled: {},
};

export const OPEN_OFFER_STATUSES: readonly OfferStatus[] = ['queued', 'sent'];

export function nextOfferStatus(from: OfferStatus, event: OfferEvent): OfferStatus {
  const to = OFFER_TRANSITIONS[from][event];
  if (!to) throw new IllegalTransitionError('offer', from, event);
  return to;
}

export function canOfferTransition(from: OfferStatus, event: OfferEvent): boolean {
  return OFFER_TRANSITIONS[from][event] !== undefined;
}

export function isOfferOpen(s: OfferStatus): boolean {
  return s === 'queued' || s === 'sent';
}

// ---------------------------------------------------------------- Candidate list

export type ListEvent = 'regenerate' | 'submit' | 'approve' | 'activate' | 'fill' | 'exhaust' | 'reopen' | 'cancel';

/**
 * draft → pending_approval → approved → active → filled | exhausted
 * Approve is allowed straight from draft (submitting is implied).
 * reopen: exhausted/filled → active (a candidate was added, or a booking was released).
 */
const LIST_TRANSITIONS: Record<ListStatus, Partial<Record<ListEvent, ListStatus>>> = {
  draft: { regenerate: 'draft', submit: 'pending_approval', approve: 'approved', cancel: 'cancelled' },
  pending_approval: { regenerate: 'draft', approve: 'approved', cancel: 'cancelled' },
  approved: { activate: 'active', cancel: 'cancelled' },
  active: { fill: 'filled', exhaust: 'exhausted', cancel: 'cancelled' },
  exhausted: { reopen: 'active', fill: 'filled', cancel: 'cancelled' },
  filled: { reopen: 'active', cancel: 'cancelled' },
  cancelled: {},
};

export function nextListStatus(from: ListStatus, event: ListEvent): ListStatus {
  const to = LIST_TRANSITIONS[from][event];
  if (!to) throw new IllegalTransitionError('candidate list', from, event);
  return to;
}

export function canListTransition(from: ListStatus, event: ListEvent): boolean {
  return LIST_TRANSITIONS[from][event] !== undefined;
}

/** Lists that have been approved: SMS may flow. */
export function isListLive(s: ListStatus): boolean {
  return s === 'approved' || s === 'active' || s === 'exhausted' || s === 'filled';
}

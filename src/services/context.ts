import type { DB, Tx } from '../db/kysely.js';
import type { SmsProvider } from '../sms/SmsProvider.js';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Optional precise wake-ups (pg-boss). The once-a-minute tick is the safety net. */
export interface Scheduler {
  wakeAt(positionId: number, at: Date): Promise<void>;
}

export const noopScheduler: Scheduler = { wakeAt: async () => {} };

export interface AppContext {
  db: DB;
  sms: SmsProvider;
  clock: Clock;
  scheduler: Scheduler;
  defaultRegion: string;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
}

export type Actor =
  | { type: 'user'; id: number; label: string; role: 'admin' | 'steward' }
  | { type: 'worker'; id: number; label: string }
  | { type: 'system'; label: string };

export const SYSTEM: Actor = { type: 'system', label: 'system' };

/** Business-rule violation that should be shown to the user (HTTP 400/409). */
export class DomainError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Work to do after a transaction commits: re-run the offer engine for positions,
 * cancel conflicting offers, schedule wake-ups. Collected inside the transaction
 * so side effects never happen for a rolled-back transaction.
 */
export class Effects {
  readonly reconcile = new Set<number>();
  readonly cancelConflicts: { workerId: number; acceptedOfferId: number }[] = [];
  readonly wakeups: { positionId: number; at: Date }[] = [];
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

export async function inTx<T>(ctx: AppContext, fn: (tx: Tx, fx: Effects) => Promise<T>): Promise<T> {
  let fx = new Effects();
  let result: T;
  for (let attempt = 1; ; attempt++) {
    fx = new Effects();
    try {
      result = await ctx.db.transaction().execute((tx) => fn(tx, fx));
      break;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
        continue;
      }
      throw err;
    }
  }
  await runEffects(ctx, fx);
  return result;
}

// Set by offerEngine to avoid a circular import.
let effectRunner: ((ctx: AppContext, fx: Effects) => Promise<void>) | null = null;
export function registerEffectRunner(fn: (ctx: AppContext, fx: Effects) => Promise<void>): void {
  effectRunner = fn;
}

async function runEffects(ctx: AppContext, fx: Effects): Promise<void> {
  if (effectRunner) await effectRunner(ctx, fx);
}

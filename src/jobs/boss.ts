import { PgBoss } from 'pg-boss';
import type { AppContext, Scheduler } from '../services/context.js';
import { reconcilePosition, tick } from '../services/offerEngine.js';
import { flushOutbox, recoverStuckSends } from '../services/outbox.js';

const TICK = 'offer-tick';
const WAKE = 'position-wake';

/**
 * Background jobs on pg-boss (same Postgres, no Redis):
 *  - offer-tick: every minute — expires offers, releases quiet-hour queues, retries SMS.
 *  - position-wake: one-off job at an offer's expires_at for near-exact timeouts.
 * Both are idempotent; the engine re-checks state under row locks.
 */
export async function startJobs(connectionString: string, getCtx: () => AppContext): Promise<{ boss: PgBoss; scheduler: Scheduler }> {
  const boss = new PgBoss({ connectionString, schema: 'pgboss' });
  boss.on('error', (err) => console.error('[pg-boss]', err));
  await boss.start();
  await boss.createQueue(TICK);
  await boss.createQueue(WAKE);

  await boss.schedule(TICK, '* * * * *');
  await boss.work(TICK, async () => {
    const ctx = getCtx();
    await recoverStuckSends(ctx);
    await tick(ctx);
  });
  await boss.work<{ positionId: number }>(WAKE, async (jobs) => {
    const ctx = getCtx();
    for (const j of jobs) await reconcilePosition(ctx, j.data.positionId);
    await flushOutbox(ctx);
  });

  const scheduler: Scheduler = {
    async wakeAt(positionId, at) {
      // +2s so the deadline has definitely passed when the job runs.
      await boss.sendAfter(WAKE, { positionId }, null, new Date(at.getTime() + 2000));
    },
  };
  return { boss, scheduler };
}

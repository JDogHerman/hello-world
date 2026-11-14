import { sql } from 'kysely';
import bcrypt from 'bcryptjs';
import { createDb, type DB } from '../../src/db/kysely.js';
import { migrateToLatest } from '../../src/db/migrator.js';
import { FakeSmsProvider } from '../../src/sms/fake.js';
import { noopScheduler, type Actor, type AppContext } from '../../src/services/context.js';
import { createJob } from '../../src/services/jobs.js';
import '../../src/services/offerEngine.js'; // registers the post-commit effect runner

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/stagehand_test';

export class TestClock {
  constructor(public current: Date) {}
  now = () => new Date(this.current);
  set(iso: string) {
    this.current = new Date(iso);
  }
  advanceMinutes(m: number) {
    this.current = new Date(this.current.getTime() + m * 60_000);
  }
}

export interface Harness {
  db: DB;
  ctx: AppContext;
  sms: FakeSmsProvider;
  clock: TestClock;
  steward: Actor;
  admin: Actor;
  ids: { venue: number; venue2: number; loadIn: number; showCall: number; rigging: number; carpentry: number };
}

let sharedDb: DB | null = null;

/** Drops and recreates the test schema, then seeds lookup data. */
export async function setupHarness(startIso = '2026-11-20T10:00:00-05:00'): Promise<Harness> {
  if (!sharedDb) sharedDb = createDb(TEST_DB_URL, 20);
  const db = sharedDb;
  await sql`DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`.execute(db);
  const quiet = console.log;
  console.log = () => {};
  try {
    await migrateToLatest(db);
  } finally {
    console.log = quiet;
  }
  const sms = new FakeSmsProvider({ silent: true });
  const clock = new TestClock(new Date(startIso));
  const ctx: AppContext = {
    db,
    sms,
    clock,
    scheduler: noopScheduler,
    defaultRegion: 'US',
    log: { info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error(...a) },
  };
  await db.updateTable('app_config').set({ timezone: 'America/New_York', local_name: 'IATSE 48 Akron/Canton' }).execute();
  const hash = await bcrypt.hash('password123', 4);
  const s = await db.insertInto('app_user').values({ email: 's@x.org', name: 'Sam Steward', role: 'steward', password_hash: hash, phone: '+12025550100' }).returning('id').executeTakeFirstOrThrow();
  const a = await db.insertInto('app_user').values({ email: 'a@x.org', name: 'Ada Admin', role: 'admin', password_hash: hash, phone: null }).returning('id').executeTakeFirstOrThrow();
  const one = async (table: 'skill' | 'job_type' | 'venue', name: string) =>
    (await db.insertInto(table as 'skill').values({ name }).returning('id').executeTakeFirstOrThrow()).id;
  const ids = {
    venue: await one('venue', 'Arena'),
    venue2: await one('venue', 'Playhouse'),
    loadIn: await one('job_type', 'Load-in'),
    showCall: await one('job_type', 'Show Call'),
    rigging: await one('skill', 'Rigging'),
    carpentry: await one('skill', 'Carpentry'),
  };
  return {
    db,
    ctx,
    sms,
    clock,
    steward: { type: 'user', id: s.id, label: 'Sam Steward', role: 'steward' },
    admin: { type: 'user', id: a.id, label: 'Ada Admin', role: 'admin' },
    ids,
  };
}

export async function closeHarness(): Promise<void> {
  await sharedDb?.destroy();
  sharedDb = null;
}

let phoneSeq = 0;
export async function addWorker(
  h: Harness,
  o: {
    first?: string;
    last: string;
    tranche?: number;
    start?: string;
    skills?: number[];
    refuseVenues?: number[];
    refuseJobTypes?: number[];
    active?: boolean;
  },
): Promise<{ id: number; phone: string }> {
  const phone = `+1202555${String(1000 + ++phoneSeq).slice(-4)}`;
  const w = await h.db
    .insertInto('worker')
    .values({
      first_name: o.first ?? 'Test',
      last_name: o.last,
      phone,
      tranche: o.tranche ?? 1,
      start_date: o.start ?? '2010-01-01',
      active: o.active ?? true,
      notes: null,
      opt_out_at: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const s of o.skills ?? [h.ids.rigging]) await h.db.insertInto('worker_skill').values({ worker_id: w.id, skill_id: s }).execute();
  for (const v of o.refuseVenues ?? []) await h.db.insertInto('worker_refusal').values({ worker_id: w.id, venue_id: v, job_type_id: null }).execute();
  for (const j of o.refuseJobTypes ?? []) await h.db.insertInto('worker_refusal').values({ worker_id: w.id, job_type_id: j, venue_id: null }).execute();
  return { id: w.id, phone };
}

export async function makeJob(
  h: Harness,
  positions: { skill_id: number; quantity: number }[],
  o: { date?: string; start?: string; end?: string; venue?: number } = {},
): Promise<{ jobId: number; positionIds: number[]; listIds: number[] }> {
  const jobId = await createJob(
    h.ctx,
    {
      venue_id: o.venue ?? h.ids.venue,
      job_type_id: h.ids.loadIn,
      date: o.date ?? '2026-11-21',
      start_time: o.start ?? '08:00',
      end_time: o.end ?? '16:00',
      notes: '',
      positions,
    },
    h.steward,
  );
  const ps = await h.db.selectFrom('position').innerJoin('candidate_list', 'candidate_list.position_id', 'position.id').select(['position.id as pid', 'candidate_list.id as lid']).where('job_id', '=', jobId).orderBy('position.id').execute();
  return { jobId, positionIds: ps.map((p) => p.pid), listIds: ps.map((p) => p.lid) };
}

/** Extracts the 4-digit offer code from the most recent offer text to `phone`. */
export function codeFrom(h: Harness, phone: string): string {
  const offer = [...h.sms.to(phone)].reverse().find((b) => b.includes('Work call'));
  const m = offer?.match(/YES (\d{4})/);
  if (!m) throw new Error(`no offer text to ${phone}: ${JSON.stringify(h.sms.to(phone))}`);
  return m[1];
}

let sid = 0;
export const nextSid = () => `SMTEST${++sid}`;

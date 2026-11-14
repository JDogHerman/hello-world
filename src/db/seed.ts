/**
 * Seeds sample data for local development: users, skills, job types, venues,
 * ~24 workers with varied tranches/skills/refusals/availability, and one job
 * whose candidate lists are generated and waiting for Steward approval.
 *
 *   npm run seed            # only if the database is empty
 *   npm run seed -- --reset # wipe all app data first
 */
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { DateTime } from 'luxon';
import { loadEnv } from '../env.js';
import { createDb } from './kysely.js';
import { migrateToLatest } from './migrator.js';
import { FakeSmsProvider } from '../sms/fake.js';
import { noopScheduler, systemClock, type Actor, type AppContext } from '../services/context.js';
import { createJob } from '../services/jobs.js';
import '../services/offerEngine.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
await migrateToLatest(db);

const reset = process.argv.includes('--reset');
const existing = await db.selectFrom('worker').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
if (Number(existing.n) > 0 && !reset) {
  console.log('Database already has data; run with --reset to wipe and reseed.');
  await db.destroy();
  process.exit(0);
}
if (reset) {
  await sql`TRUNCATE audit_log, alert, sms_message, booking, offer, candidate_exclusion, candidate_entry, candidate_list,
    position, job, worker_unavailability, worker_refusal, worker_skill, venue, job_type, skill, worker, app_user RESTART IDENTITY CASCADE`.execute(db);
  await db.updateTable('app_config').set({ reply_window_minutes: 60, offers_per_open_slot: 1, quiet_hours_start: '21:00', quiet_hours_end: '08:00', local_name: 'IATSE 48 Akron/Canton', booking_buffer_minutes: 0 }).execute();
}

const tz = 'America/New_York';
await db.updateTable('app_config').set({ timezone: tz }).execute();

const pw = (p: string) => bcrypt.hashSync(p, 10);
const admin = await db.insertInto('app_user').values({ email: 'admin@iatse48.test', name: 'Alex Admin', role: 'admin', password_hash: pw('admin12345'), phone: null }).returning('id').executeTakeFirstOrThrow();
const steward = await db.insertInto('app_user').values({ email: 'steward@iatse48.test', name: 'Sam Steward', role: 'steward', password_hash: pw('steward12345'), phone: '+13305550199' }).returning('id').executeTakeFirstOrThrow();

const names = async (table: 'skill' | 'job_type', list: string[]) => {
  const out: Record<string, number> = {};
  for (const name of list) out[name] = (await db.insertInto(table).values({ name }).returning('id').executeTakeFirstOrThrow()).id;
  return out;
};
const skills = await names('skill', ['Rigging', 'Carpentry', 'Electrics', 'Audio', 'Props', 'Wardrobe', 'Fly Rail', 'Spot Op']);
const jobTypes = await names('job_type', ['Load-in', 'Load-out', 'Show Call', 'Rehearsal']);
const venues: Record<string, number> = {};
for (const [name, address] of [
  ['Akron Civic Theatre', 'Akron, OH'],
  ['E.J. Thomas Performing Arts Hall', 'Akron, OH'],
  ['Canton Palace Theatre', 'Canton, OH'],
  ['Canton Memorial Civic Center', 'Canton, OH'],
]) venues[name] = (await db.insertInto('venue').values({ name, address }).returning('id').executeTakeFirstOrThrow()).id;

type W = [first: string, last: string, tranche: number, start: string, skills: string[], refuse?: string[]];
const workers: W[] = [
  ['Maria', 'Alvarez', 1, '1998-03-02', ['Rigging', 'Fly Rail']],
  ['James', 'Okafor', 1, '2001-06-15', ['Rigging', 'Carpentry']],
  ['Linda', 'Chen', 1, '2001-06-15', ['Electrics', 'Spot Op']],
  ['Robert', 'Byrne', 1, '2003-09-01', ['Rigging'], ['venue:Akron Civic Theatre']],
  ['Patricia', 'Novak', 1, '2005-01-10', ['Audio', 'Electrics']],
  ['Michael', 'Dubois', 1, '2006-04-22', ['Carpentry', 'Props']],
  ['Susan', 'Kowalski', 1, '2008-11-30', ['Wardrobe', 'Props']],
  ['David', 'Reyes', 2, '2004-02-14', ['Rigging', 'Electrics']],
  ['Karen', 'Murphy', 2, '2009-07-07', ['Carpentry'], ['job_type:Load-out']],
  ['Thomas', 'Nguyen', 2, '2010-05-19', ['Audio']],
  ['Nancy', 'Fischer', 2, '2011-08-08', ['Spot Op', 'Electrics']],
  ['Daniel', 'Hughes', 2, '2012-12-01', ['Rigging', 'Fly Rail']],
  ['Lisa', 'Romano', 2, '2013-03-15', ['Props', 'Carpentry']],
  ['Mark', 'Johansson', 2, '2014-10-20', ['Rigging', 'Carpentry', 'Electrics']],
  ['Betty', 'Adeyemi', 3, '2015-01-05', ['Wardrobe']],
  ['Paul', 'Schmidt', 3, '2016-06-30', ['Carpentry', 'Rigging']],
  ['Sandra', 'Park', 3, '2017-09-12', ['Audio', 'Spot Op']],
  ['Steven', 'Walsh', 3, '2018-02-28', ['Electrics']],
  ['Emily', 'Torres', 3, '2019-04-04', ['Rigging'], ['job_type:Load-in']],
  ['Kevin', 'Brennan', 3, '2020-07-17', ['Carpentry', 'Props']],
  ['Laura', 'Singh', 4, '2021-01-11', ['Rigging', 'Audio']],
  ['Brian', 'Costa', 4, '2022-03-03', ['Carpentry', 'Electrics']],
  ['Megan', 'Ward', 4, '2023-05-25', ['Wardrobe', 'Props']],
  ['Jason', 'Lee', 4, '2024-08-19', ['Rigging', 'Carpentry']],
];

const ids: number[] = [];
for (let i = 0; i < workers.length; i++) {
  const [first, last, tranche, start, sk, refuse = []] = workers[i];
  const w = await db
    .insertInto('worker')
    .values({ first_name: first, last_name: last, phone: `+1330555${String(100 + i).padStart(4, '0')}`, tranche, start_date: start, notes: null, opt_out_at: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  ids.push(w.id);
  for (const s of sk) await db.insertInto('worker_skill').values({ worker_id: w.id, skill_id: skills[s] }).execute();
  for (const r of refuse) {
    const [kind, name] = r.split(':');
    await db.insertInto('worker_refusal').values({
      worker_id: w.id,
      job_type_id: kind === 'job_type' ? jobTypes[name] : null,
      venue_id: kind === 'venue' ? venues[name] : null,
      reason: 'Seed data',
    }).execute();
  }
}
// Mark one inactive and one opted out so the exclusion reasons are visible.
await db.updateTable('worker').set({ active: false }).where('id', '=', ids[11]).execute();
await db.updateTable('worker').set({ sms_opt_out: true, opt_out_at: new Date() }).where('id', '=', ids[13]).execute();

// A sample job one week out, Saturday-ish, 8 AM - 4 PM local.
const jobDay = DateTime.now().setZone(tz).plus({ days: 7 }).toFormat('yyyy-MM-dd');
const dayStart = DateTime.fromISO(`${jobDay}T00:00`, { zone: tz });
// David Reyes is unavailable that morning.
await db.insertInto('worker_unavailability').values({
  worker_id: ids[7],
  starts_at: dayStart.set({ hour: 6 }).toJSDate(),
  ends_at: dayStart.set({ hour: 12 }).toJSDate(),
  note: 'Doctor appointment',
}).execute();

const ctx: AppContext = {
  db,
  sms: new FakeSmsProvider(),
  clock: systemClock,
  scheduler: noopScheduler,
  defaultRegion: env.DEFAULT_PHONE_REGION,
  log: console,
};
const actor: Actor = { type: 'user', id: steward.id, label: 'Sam Steward', role: 'steward' };
const jobId = await createJob(
  ctx,
  {
    venue_id: venues['Akron Civic Theatre'],
    job_type_id: jobTypes['Load-in'],
    date: jobDay,
    start_time: '08:00',
    end_time: '16:00',
    notes: 'Touring production — 2 trucks. Sample job created by the seed script.',
    positions: [
      { skill_id: skills['Rigging'], quantity: 2 },
      { skill_id: skills['Carpentry'], quantity: 2 },
      { skill_id: skills['Electrics'], quantity: 1 },
    ],
  },
  actor,
);

console.log(`Seeded ${workers.length} workers, 8 skills, 4 job types, 4 venues and job #${jobId} (${jobDay}).`);
console.log('Log in as  admin@iatse48.test / admin12345   or   steward@iatse48.test / steward12345');
void admin;
await db.destroy();

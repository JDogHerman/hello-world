import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addEntry, approve, removeEntry } from '../../src/services/candidateLists.js';
import { handleInboundSms } from '../../src/services/inboundSms.js';
import { cancelJob, releaseBooking } from '../../src/services/jobs.js';
import { tick } from '../../src/services/offerEngine.js';
import { addWorker, closeHarness, codeFrom, makeJob, nextSid, setupHarness, type Harness } from './harness.js';

let h: Harness;
const reply = (from: string, body: string, providerSid = nextSid()) => handleInboundSms(h.ctx, { from, body, providerSid });

const offersFor = (positionId: number) =>
  h.db.selectFrom('offer').selectAll().where('position_id', '=', positionId).orderBy('id').execute();
const position = (id: number) => h.db.selectFrom('position').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
const list = (id: number) => h.db.selectFrom('candidate_list').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

beforeEach(async () => {
  h = await setupHarness();
});
afterAll(closeHarness);

describe('full offer flow: offer → decline → next → timeout → next → accept', () => {
  it('walks the list in order and fills the position', async () => {
    const senior = await addWorker(h, { last: 'Senior', tranche: 1, start: '2001-01-01' });
    const middle = await addWorker(h, { last: 'Middle', tranche: 1, start: '2010-01-01' });
    const t2 = await addWorker(h, { last: 'TrancheTwo', tranche: 2, start: '1990-01-01' });
    const refuser = await addWorker(h, { last: 'Refuser', refuseVenues: [h.ids.venue] });
    const carpenter = await addWorker(h, { last: 'Carpenter', skills: [h.ids.carpentry] });

    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    const [pid] = positionIds;
    const [lid] = listIds;

    // Draft list: ranked, with exclusion reasons recorded.
    const entries = await h.db.selectFrom('candidate_entry').select(['worker_id', 'rank']).where('list_id', '=', lid).orderBy('rank').execute();
    expect(entries.map((e) => e.worker_id)).toEqual([senior.id, middle.id, t2.id]);
    const excl = await h.db.selectFrom('candidate_exclusion').selectAll().where('list_id', '=', lid).orderBy('worker_id').execute();
    expect(excl.map((e) => [e.worker_id, e.reasons])).toEqual([
      [refuser.id, ['refused_venue']],
      [carpenter.id, ['missing_skill']],
    ]);

    // Nothing is texted before approval, even if the tick runs.
    await tick(h.ctx);
    expect(h.sms.sent).toHaveLength(0);

    // Only a Steward can approve.
    await expect(approve(h.ctx, lid, h.admin)).rejects.toThrow(/Only a Steward/);
    await approve(h.ctx, lid, h.steward);
    expect((await list(lid)).status).toBe('active');
    expect(h.sms.sent).toHaveLength(1);
    const offerText = h.sms.last(senior.phone)!;
    expect(offerText).toMatch(
      /^\[Local 123\] Work call: Load-in at Arena, Sat 11\/21, 8:00 AM, Position: Rigging\. Reply YES \d{4} to accept or NO \d{4} to decline\. Expires in 60 min\.$/,
    );

    // 1) Senior declines → Middle is offered.
    expect(await reply(senior.phone, `NO ${codeFrom(h, senior.phone)}`)).toBe('declined');
    expect(h.sms.last(senior.phone)).toMatch(/declined offer/);
    expect(h.sms.to(middle.phone)).toHaveLength(1);

    // 2) Middle never replies → expires after 60 min → TrancheTwo is offered.
    const middleCode = codeFrom(h, middle.phone);
    h.clock.advanceMinutes(59);
    await tick(h.ctx);
    expect(h.sms.to(t2.phone)).toHaveLength(0);
    h.clock.advanceMinutes(2);
    await tick(h.ctx);
    expect(h.sms.to(t2.phone)).toHaveLength(1);

    // Late reply from Middle is told the offer expired, and nothing changes.
    expect(await reply(middle.phone, `YES ${middleCode}`)).toBe('closed');
    expect(h.sms.last(middle.phone)).toMatch(/has expired/);

    // 3) TrancheTwo accepts → filled, confirmation, booking created.
    expect(await reply(t2.phone, `yes ${codeFrom(h, t2.phone)}`)).toBe('accepted');
    expect(h.sms.last(t2.phone)).toMatch(/Confirmed/);

    const offers = await offersFor(pid);
    expect(offers.map((o) => [o.worker_id, o.status])).toEqual([
      [senior.id, 'declined'],
      [middle.id, 'expired'],
      [t2.id, 'accepted'],
    ]);
    const p = await position(pid);
    expect([p.status, p.filled_count]).toEqual(['filled', 1]);
    expect((await list(lid)).status).toBe('filled');
    const booking = await h.db.selectFrom('booking').selectAll().where('worker_id', '=', t2.id).executeTakeFirstOrThrow();
    expect(booking.position_id).toBe(pid);

    // Audit trail covers approval, every SMS in and out, and every offer transition.
    const actions = (await h.db.selectFrom('audit_log').select('action').orderBy('id').execute()).map((a) => a.action);
    for (const a of ['list.approved', 'offer.sent', 'sms.sent', 'sms.received', 'offer.declined', 'offer.expired', 'offer.accepted', 'position.filled']) {
      expect(actions).toContain(a);
    }
    const approval = await h.db.selectFrom('audit_log').selectAll().where('action', '=', 'list.approved').executeTakeFirstOrThrow();
    expect([approval.actor_type, approval.actor_id]).toEqual(['user', (h.steward as { id: number }).id]);
  });
});

describe('race safety', () => {
  it('two simultaneous YES replies for the last slot: exactly one wins', async () => {
    await h.db.updateTable('app_config').set({ offers_per_open_slot: 2 }).execute();
    const a = await addWorker(h, { last: 'Alpha', start: '2001-01-01' });
    const b = await addWorker(h, { last: 'Bravo', start: '2002-01-01' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const ca = codeFrom(h, a.phone);
    const cb = codeFrom(h, b.phone);

    const results = await Promise.all([reply(a.phone, `YES ${ca}`), reply(b.phone, `YES ${cb}`)]);
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    const loserPhone = results[0] === 'accepted' ? b.phone : a.phone;
    expect(h.sms.last(loserPhone)).toMatch(/has been filled/);

    const p = await position(positionIds[0]);
    expect(p.filled_count).toBe(1);
    const bookings = await h.db.selectFrom('booking').selectAll().where('position_id', '=', p.id).execute();
    expect(bookings).toHaveLength(1);
  });

  it('many concurrent accepts never overfill a multi-slot position', async () => {
    await h.db.updateTable('app_config').set({ offers_per_open_slot: 3 }).execute();
    const ws = [];
    for (let i = 0; i < 8; i++) ws.push(await addWorker(h, { last: `W${i}`, start: `20${10 + i}-01-01` }));
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 2 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const offered = ws.filter((w) => h.sms.to(w.phone).length > 0);
    expect(offered).toHaveLength(6);
    await Promise.all(offered.map((w) => reply(w.phone, `YES ${codeFrom(h, w.phone)}`)));
    const p = await position(positionIds[0]);
    expect([p.filled_count, p.status]).toEqual([2, 'filled']);
    const open = (await offersFor(p.id)).filter((o) => o.status === 'sent' || o.status === 'queued');
    expect(open).toHaveLength(0);
  });
});

describe('quiet hours', () => {
  it('queues offers during quiet hours and pauses the countdown', async () => {
    h.clock.set('2026-11-20T22:00:00-05:00');
    const a = await addWorker(h, { last: 'Alpha' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    expect(h.sms.sent).toHaveLength(0);
    expect((await offersFor(positionIds[0]))[0].status).toBe('queued');

    h.clock.set('2026-11-21T07:59:00-05:00');
    await tick(h.ctx);
    expect(h.sms.sent).toHaveLength(0);

    h.clock.set('2026-11-21T08:00:00-05:00');
    await tick(h.ctx);
    const [o] = await offersFor(positionIds[0]);
    expect(o.status).toBe('sent');
    expect(o.expires_at!.toISOString()).toBe(new Date('2026-11-21T09:00:00-05:00').toISOString());
    expect(h.sms.to(a.phone)).toHaveLength(1);
  });

  it('an offer sent just before quiet hours expires the next morning', async () => {
    h.clock.set('2026-11-20T20:30:00-05:00');
    const a = await addWorker(h, { last: 'Alpha' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }], { date: '2026-11-22' });
    await approve(h.ctx, listIds[0], h.steward);
    const [o] = await offersFor(positionIds[0]);
    expect(o.expires_at!.toISOString()).toBe(new Date('2026-11-21T08:30:00-05:00').toISOString());
    expect(h.sms.last(a.phone)).toMatch(/Expires Sat 11\/21 8:30 AM\./);
  });

  it('a reply during quiet hours is answered immediately (it is worker-initiated)', async () => {
    h.clock.set('2026-11-20T20:30:00-05:00');
    const a = await addWorker(h, { last: 'Alpha' });
    const { listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }], { date: '2026-11-22' });
    await approve(h.ctx, listIds[0], h.steward);
    h.clock.set('2026-11-20T23:15:00-05:00');
    expect(await reply(a.phone, `YES ${codeFrom(h, a.phone)}`)).toBe('accepted');
    expect(h.sms.last(a.phone)).toMatch(/Confirmed/);
  });
});

describe('inbound edge cases', () => {
  it('webhook retries with the same provider SID are processed once', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const body = `NO ${codeFrom(h, a.phone)}`;
    expect(await reply(a.phone, body, 'SM-dup')).toBe('declined');
    expect(await reply(a.phone, body, 'SM-dup')).toBe('duplicate');
    expect(h.sms.to(b.phone)).toHaveLength(1);
    expect(await offersFor(positionIds[0])).toHaveLength(2);
  });

  it('an unrecognized reply gets help text and leaves the offer open', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const code = codeFrom(h, a.phone);
    expect(await reply(a.phone, 'maybe later?')).toBe('unrecognized');
    expect(h.sms.last(a.phone)).toContain(`Your open offers: ${code}`);
    expect((await offersFor(positionIds[0]))[0].status).toBe('sent');
  });

  it('a bare YES applies when exactly one offer is open; asks for the code when several are', async () => {
    const a = await addWorker(h, { last: 'Alpha', skills: [h.ids.rigging, h.ids.carpentry] });
    const j1 = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }], { date: '2026-11-21' });
    const j2 = await makeJob(h, [{ skill_id: h.ids.carpentry, quantity: 1 }], { date: '2026-11-22' });
    await approve(h.ctx, j1.listIds[0], h.steward);
    await approve(h.ctx, j2.listIds[0], h.steward);
    expect(await reply(a.phone, 'yes')).toBe('ambiguous');
    expect(await reply(a.phone, `YES ${codeFrom(h, a.phone)}`)).toBe('accepted'); // latest = job 2
    expect(await reply(a.phone, 'Y')).toBe('accepted'); // only job 1 left
    expect((await position(j1.positionIds[0])).status).toBe('filled');
  });

  it('a wrong code is reported with the open codes', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const { listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const code = codeFrom(h, a.phone);
    const wrong = code === '1111' ? '2222' : '1111';
    expect(await reply(a.phone, `YES ${wrong}`)).toBe('unknown_code');
    expect(h.sms.last(a.phone)).toContain(`couldn't find offer ${wrong}`);
  });

  it('STOP opts out, withdraws open offers, moves on, and blocks further texts; START opts back in', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const before = h.sms.to(a.phone).length;
    expect(await reply(a.phone, 'STOP')).toBe('opted_out');
    expect(h.sms.to(a.phone)).toHaveLength(before); // carrier sends the confirmation, not us
    const offers = await offersFor(positionIds[0]);
    expect(offers.map((o) => o.status)).toEqual(['cancelled', 'sent']);
    expect(h.sms.to(b.phone)).toHaveLength(1);
    expect((await h.db.selectFrom('worker').select('sms_opt_out').where('id', '=', a.id).executeTakeFirstOrThrow()).sms_opt_out).toBe(true);
    expect(await reply(a.phone, 'hello?')).toBe('ignored_opted_out');
    expect(await reply(a.phone, 'START')).toBe('opted_in');
    expect((await h.db.selectFrom('worker').select('sms_opt_out').where('id', '=', a.id).executeTakeFirstOrThrow()).sms_opt_out).toBe(false);
  });

  it('a reply at the deadline, before the tick ran, is treated as expired', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    h.clock.advanceMinutes(60);
    expect(await reply(a.phone, `YES ${codeFrom(h, a.phone)}`)).toBe('expired');
    expect(h.sms.to(b.phone)).toHaveLength(1);
  });
});

describe('cross-position and cross-job rules', () => {
  it('a worker is not offered two positions on the same job at once', async () => {
    const both = await addWorker(h, { last: 'Both', start: '2001-01-01', skills: [h.ids.rigging, h.ids.carpentry] });
    const carp = await addWorker(h, { last: 'Carp', start: '2005-01-01', skills: [h.ids.carpentry] });
    const { positionIds, listIds } = await makeJob(h, [
      { skill_id: h.ids.rigging, quantity: 1 },
      { skill_id: h.ids.carpentry, quantity: 1 },
    ]);
    await approve(h.ctx, listIds[0], h.steward);
    await approve(h.ctx, listIds[1], h.steward);
    expect(h.sms.to(both.phone)).toHaveLength(1);
    expect(h.sms.to(carp.phone)).toHaveLength(1);
    const skipped = await h.db.selectFrom('candidate_entry').selectAll().where('list_id', '=', listIds[1]).where('worker_id', '=', both.id).executeTakeFirstOrThrow();
    expect(skipped.skipped_reasons).toEqual(['already_on_job']);
    expect((await offersFor(positionIds[1])).map((o) => o.worker_id)).toEqual([carp.id]);
  });

  it('accepting one call withdraws overlapping offers on other jobs', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const j1 = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }], { start: '08:00', end: '16:00' });
    const j2 = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }], { start: '12:00', end: '20:00', venue: h.ids.venue2 });
    await approve(h.ctx, j1.listIds[0], h.steward);
    const c1 = codeFrom(h, a.phone);
    await approve(h.ctx, j2.listIds[0], h.steward);
    expect(await reply(a.phone, `YES ${c1}`)).toBe('accepted');
    const j2offers = await offersFor(j2.positionIds[0]);
    expect(j2offers.map((o) => [o.worker_id, o.status, o.cancel_reason])).toEqual([
      [a.id, 'cancelled', 'conflict'],
      [b.id, 'sent', null],
    ]);
  });

  it('exhausts and alerts when the list runs out, and recovers when a candidate is added', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const late = await addWorker(h, { last: 'Late', skills: [h.ids.carpentry] });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 2 }]);
    await approve(h.ctx, listIds[0], h.steward);
    expect(await reply(a.phone, `YES ${codeFrom(h, a.phone)}`)).toBe('accepted');
    let p = await position(positionIds[0]);
    expect([p.status, p.filled_count]).toEqual(['exhausted', 1]);
    expect((await list(listIds[0])).status).toBe('exhausted');
    const alerts = await h.db.selectFrom('alert').selectAll().execute();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/ran out of candidates \(1\/2 filled\)/);

    // Missing-skill is overridable by the Steward with a logged reason.
    await expect(addEntry(h.ctx, listIds[0], late.id, null, 'Can rig in a pinch', h.steward)).rejects.toThrow(/override/);
    await addEntry(h.ctx, listIds[0], late.id, null, 'Can rig in a pinch', h.steward, true);
    p = await position(positionIds[0]);
    expect(p.status).toBe('open');
    expect(h.sms.to(late.phone)).toHaveLength(1);
  });

  it('removing a worker with an outstanding offer withdraws it and moves to the next', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const entry = await h.db.selectFrom('candidate_entry').selectAll().where('worker_id', '=', a.id).executeTakeFirstOrThrow();
    await expect(removeEntry(h.ctx, entry.id, '', h.steward)).rejects.toThrow(/reason is required/);
    await removeEntry(h.ctx, entry.id, 'Injured', h.steward);
    expect(h.sms.last(a.phone)).toMatch(/withdrawn/);
    expect(h.sms.to(b.phone)).toHaveLength(1);
  });

  it('cancelling a job withdraws offers and notifies accepted workers', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { jobId, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 2 }]);
    await approve(h.ctx, listIds[0], h.steward);
    await reply(a.phone, `YES ${codeFrom(h, a.phone)}`);
    await cancelJob(h.ctx, jobId, 'Show postponed', h.steward);
    expect(h.sms.last(a.phone)).toMatch(/CANCELLED/);
    expect(h.sms.last(b.phone)).toMatch(/withdrawn/);
    const bookings = await h.db.selectFrom('booking').selectAll().execute();
    expect(bookings.every((x) => x.cancelled_at !== null)).toBe(true);
  });

  it('releasing a booking reopens the slot and offers the next worker', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const b = await addWorker(h, { last: 'Bravo', start: '2015-01-01' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    await reply(a.phone, `YES ${codeFrom(h, a.phone)}`);
    expect((await position(positionIds[0])).status).toBe('filled');
    const booking = await h.db.selectFrom('booking').selectAll().executeTakeFirstOrThrow();
    await releaseBooking(h.ctx, booking.id, 'Called in sick', h.steward);
    expect((await position(positionIds[0])).status).toBe('open');
    expect(h.sms.to(b.phone)).toHaveLength(1);
  });

  it('retries a failed send on the next tick', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const { listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    h.sms.failNext = 1;
    await approve(h.ctx, listIds[0], h.steward);
    expect(h.sms.to(a.phone)).toHaveLength(0);
    h.clock.advanceMinutes(2);
    await tick(h.ctx);
    expect(h.sms.to(a.phone)).toHaveLength(1);
  });
});

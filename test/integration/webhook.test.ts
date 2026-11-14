import twilio from 'twilio';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { approve } from '../../src/services/candidateLists.js';
import { buildServer } from '../../src/web/server.js';
import { addWorker, closeHarness, codeFrom, makeJob, setupHarness, type Harness } from './harness.js';

const TOKEN = 'test_auth_token_123';
const BASE = 'https://stagehand.example.org';
let h: Harness;
let app: FastifyInstance;

beforeEach(async () => {
  h = await setupHarness();
  app = await buildServer({
    ctx: h.ctx,
    env: {
      SESSION_SECRET: 'x'.repeat(32),
      PUBLIC_BASE_URL: BASE,
      TWILIO_AUTH_TOKEN: TOKEN,
      TWILIO_VALIDATE_SIGNATURE: true,
      SMS_PROVIDER: 'console',
      NODE_ENV: 'test',
    },
  });
});
afterAll(async () => {
  await app?.close();
  await closeHarness();
});

function post(params: Record<string, string>, signature?: string) {
  const sig = signature ?? twilio.getExpectedTwilioSignature(TOKEN, `${BASE}/sms/inbound`, params);
  return app.inject({
    method: 'POST',
    url: '/sms/inbound',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    payload: new URLSearchParams(params).toString(),
  });
}

describe('Twilio inbound webhook', () => {
  it('accepts a correctly signed message and processes the reply', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const { positionIds, listIds } = await makeJob(h, [{ skill_id: h.ids.rigging, quantity: 1 }]);
    await approve(h.ctx, listIds[0], h.steward);
    const res = await post({ MessageSid: 'SM1', From: a.phone, To: '+15550000000', Body: `YES ${codeFrom(h, a.phone)}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.body).toContain('<Response>');
    const p = await h.db.selectFrom('position').selectAll().where('id', '=', positionIds[0]).executeTakeFirstOrThrow();
    expect(p.filled_count).toBe(1);
  });

  it('rejects a bad or missing signature without processing', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const bad = await post({ MessageSid: 'SM2', From: a.phone, Body: 'HELP' }, 'not-a-real-signature');
    expect(bad.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'POST',
      url: '/sms/inbound',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'MessageSid=SM3&Body=HELP',
    });
    expect(missing.statusCode).toBe(403);
    const rows = await h.db.selectFrom('sms_message').selectAll().where('direction', '=', 'inbound').execute();
    expect(rows).toHaveLength(0);
  });

  it('is idempotent across Twilio retries of the same MessageSid', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const params = { MessageSid: 'SM-retry', From: a.phone, Body: 'HELP' };
    expect((await post(params)).statusCode).toBe(200);
    expect((await post(params)).statusCode).toBe(200);
    const inbound = await h.db.selectFrom('sms_message').selectAll().where('direction', '=', 'inbound').execute();
    expect(inbound).toHaveLength(1);
    expect(h.sms.to(a.phone)).toHaveLength(1); // one help reply, not two
  });

  it('normalizes the From number to E.164', async () => {
    const a = await addWorker(h, { last: 'Alpha' });
    const national = a.phone.replace('+1', '');
    expect((await post({ MessageSid: 'SM-n', From: national, Body: 'HELP' })).statusCode).toBe(200);
    expect(h.sms.to(a.phone)).toHaveLength(1);
  });
});

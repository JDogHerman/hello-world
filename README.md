# Stagehand Work-Call Scheduler

A web app that schedules union stagehands for work calls. It keeps the roster, builds a
ranked candidate list for every position on a job, waits for a **Steward to approve** the
list, then texts offers to workers one at a time. Workers reply **YES/NO + code** by SMS.
A decline or a timeout moves the offer to the next person in line.

- **Stack:** TypeScript on Node 22, Fastify, PostgreSQL 16 (Kysely + migrations), pg-boss for
  background jobs, Twilio for SMS (behind a swappable interface), and server-rendered EJS pages.
- **Roles:** *Admin* (roster, lists, settings, users), *Steward* (jobs and candidate lists; the
  **only** role that can approve a list), and *Worker* (SMS only, no login).

---

## Quick start (Docker Compose)

```bash
docker compose up --build                          # Postgres + app on http://localhost:3000
docker compose exec app node dist/db/seed.js       # sample data (first run only)
```

## Quick start (local Node)

```bash
cp .env.example .env              # defaults work with the compose database
docker compose up -d db           # or point DATABASE_URL at your own Postgres 16
npm install
npm run migrate
npm run seed                      # or: npm run seed:reset  to wipe and reseed
npm run dev                       # http://localhost:3000, reloads on change
```

Sample logins from the seed script:

| Role    | Email                    | Password       |
|---------|--------------------------|----------------|
| Admin   | `admin@iatse48.test`     | `admin12345`   |
| Steward | `steward@iatse48.test`   | `steward12345` |

The seed creates 24 workers across 4 tranches. A few are deliberately excluded (inactive, opted
out, refusing a venue or job type, or unavailable), so every exclusion reason shows up. It also
creates one job a week out with Rigging ×2, Carpentry ×2 and Electrics ×1, whose lists are
waiting for approval.

### Trying the SMS flow without Twilio

With `SMS_PROVIDER=console` (the default):

- Outbound texts are printed to the server console and listed on the **SMS** page.
- Each job page has a **"Simulate a worker's text reply"** box (dev only). Choose a worker, type
  `YES 1234` or `NO 1234`, and it goes through exactly the same handler as the Twilio webhook.
- Quiet hours default to 21:00–08:00 in `America/New_York`. Offers approved at night are held
  ("queued") until 08:00. To test at night, set quiet hours to `00:00`–`00:00` on **Settings**,
  which disables them. Held offers go out on the next minute tick.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stagehand` | App database |
| `TEST_DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/stagehand_test` | Used by integration tests. **Its `public` schema is dropped on every test run.** |
| `PORT` | `3000` | HTTP port |
| `SESSION_SECRET` | dev value | Signs session cookies. **Required in production** (≥16 chars). |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | The public URL Twilio calls. Must match the webhook URL configured in Twilio **exactly**, because it is part of the signature. Use an `https://` URL in production; that also turns on `Secure` cookies. |
| `SMS_PROVIDER` | `console` | `console` (fake: logs texts) or `twilio` |
| `TWILIO_ACCOUNT_SID` | — | Required when `SMS_PROVIDER=twilio` |
| `TWILIO_AUTH_TOKEN` | — | Required for sending **and** for validating webhook signatures |
| `TWILIO_FROM_NUMBER` | — | Sending number in E.164, **or** … |
| `TWILIO_MESSAGING_SERVICE_SID` | — | … a Messaging Service SID (`MG…`); takes precedence |
| `TWILIO_VALIDATE_SIGNATURE` | `true` | Set to `false` **only** to hit the webhook by hand during local testing |
| `DEFAULT_PHONE_REGION` | `US` | Region used to parse phone numbers entered without a country code |

Operational settings live in the database and are edited on **Settings** (Admin): the reply
window, offers out at once per open slot, quiet hours, timezone, the union name shown in the
app ("IATSE 48 Akron/Canton"), the short SMS prefix that starts every text ("IA48"), the minimum gap between a worker's calls, and whether Stewards get an SMS alert
when a list runs out.

## Twilio setup

1. Buy an SMS-capable number, or create a Messaging Service.
2. Set the number's **"A message comes in"** webhook to `POST {PUBLIC_BASE_URL}/sms/inbound`.
3. Set `SMS_PROVIDER=twilio` and the `TWILIO_*` variables, then restart.
4. Keep Twilio's default **opt-out handling** on. Twilio answers STOP/START/HELP keywords at the
   carrier level. This app records opt-outs and opt-ins and cancels open offers, but it does
   **not** send its own STOP/START confirmation, to avoid duplicate texts.
5. For local testing against real Twilio, expose port 3000 with a tunnel (for example
   `ngrok http 3000`) and set `PUBLIC_BASE_URL` to the tunnel URL.

US long-code traffic requires A2P 10DLC registration. Register the campaign before going live.

---

## Running tests

```bash
npm test                    # everything (unit + integration)
npm run test:unit           # pure logic only, no database needed
npm run test:integration    # needs Postgres at TEST_DATABASE_URL
npm run typecheck
```

- **Unit** (`test/unit`): candidate selection (every exclusion reason, sort order and
  determinism, buffer, overrides), the offer and list state machines, quiet-hour arithmetic
  (overnight windows, multi-day, DST), reply parsing, E.164 normalization.
- **Integration** (`test/integration`): runs against a real Postgres with the fake SMS provider
  and a controllable clock:
  - The full **offer → decline → next worker → timeout → next worker → accept** flow, including
    the late "expired" reply and the audit trail.
  - **Race safety**: concurrent YES replies for the last slot, where exactly one wins, and
    8 concurrent accepts for 2 slots, which never overfill.
  - Quiet-hour queuing and the paused countdown, plus opt-out/opt-in, idempotent retries,
    unknown or ambiguous codes, cross-job conflicts, exhaustion alerts, job cancellation,
    booking release and SMS retry.
  - The **Twilio webhook**: signature validation, rejection of bad or missing signatures,
    MessageSid idempotency, and E.164 normalization.

---

## How it works

### Data model
`worker`, `skill`, `worker_skill`, `job_type`, `venue`, `worker_refusal` (exactly one of job
type or venue), `worker_unavailability`, `job`, `position`, `candidate_list`, `candidate_entry`
(rank, manual/auto, removal reason, dispatch-time skip reasons), `candidate_exclusion` (reasons
snapshot), `offer`, `booking` (accepted calls, used for double-booking checks), `sms_message`
(inbound log and outbound outbox), `alert`, `audit_log`, `app_user`, `app_config`.
See `src/db/migrations/001_initial.ts`.

### Candidate selection: `src/domain/selection.ts`
A pure function. A worker is **excluded** if any of these apply (all reasons are recorded and
shown to the Steward): inactive · opted out · missing skill · refuses the job type · refuses
the venue · marked unavailable · overlapping accepted call (± buffer) · already holding or
offered another position on the same job. Eligible workers are **sorted** by tranche
ascending, then `start_date` ascending, then last name, then id.

Lists can go stale between approval and sending, so the same checks run again just before
each text. A worker who no longer qualifies is skipped, the skip is logged, and they are
reconsidered later if they become eligible again. When a Steward hand-adds a worker, the
"soft" reasons (skill, refusals) can be overridden. The hard reasons cannot.

### Offer state machine: `src/domain/stateMachines.ts`
```
queued ──send──► sent ──YES──► accepted
  │  (held in       ├──NO───► declined   → offer to next
  │  quiet hours)   ├─timeout► expired    → offer to next
  └──cancel──►      └─cancel─► cancelled  (filled / withdrawn / conflict / opted out)
```
Candidate lists go `draft → pending_approval → approved → active → filled | exhausted`.
No text is ever sent for a list that hasn't been approved.

### Offer engine: `src/services/offerEngine.ts`
`reconcilePosition` is the one place that decides what happens next for a position. It runs
under the position's row lock and does the following, in order:

1. Expires overdue offers.
2. Releases offers held for quiet hours, re-checking eligibility first.
3. Tops up outstanding offers to `open slots × offers per slot`.
4. Marks the position filled and stands everyone else down, or marks it exhausted and raises
   an alert.

It runs after approval, after every reply, every minute from the pg-boss tick, and at each
offer's exact expiry through a pg-boss one-off job.

**Race safety:** an accept takes row locks in a fixed order (worker → position → offer) and
re-reads state under the lock, so two YES replies for the last slot are serialized. The second
gets "this spot has been filled". `FOR NO KEY UPDATE` is used so foreign-key checks don't
deadlock against it. Accepting also withdraws that worker's other open offers that overlap in
time.

**Outbox:** texts are written to `sms_message` in the same transaction as the state change and
sent after commit, with retry and backoff. A rolled-back accept can never have sent a
confirmation.

**Quiet hours:** offers created during quiet hours stay `queued`. A sent offer's countdown
counts only non-quiet time, so a 60-minute offer sent at 8:30 PM expires at 8:30 AM. Replies
to a worker's own text are always answered immediately.

### Replies a worker can send
| Text | Effect |
|---|---|
| `YES 4821` / `NO 4821` | Accept or decline that offer (also `Y`, `N`, `ACCEPT`, `DECLINE`; any case or punctuation) |
| `YES` / `NO` (no code) | Applies to the worker's only open offer; asks for the code if they have several |
| `STOP`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, … | Opts out and withdraws their open offers |
| `START`, `UNSTOP` | Opts back in. Only the worker can do this; Admins can opt someone out but never in. |
| `HELP` or anything unrecognized | Help text listing their open codes; offers stay open |
| Any reply to an expired, filled or withdrawn offer | Explains that the offer is no longer open |

---

## Project layout
```
src/
  domain/      pure logic: selection, state machines, quiet hours, reply parser, phone, time
  db/          Kysely types, migrations, migrator, seed
  services/    offer engine, candidate lists, inbound SMS, jobs, workers, outbox, audit, config
  sms/         SmsProvider interface, Twilio + console providers, message templates
  jobs/        pg-boss tick and wake-ups
  web/         Fastify server, auth, routes, view helpers
  views/       EJS templates          public/  CSS + small progressive-enhancement JS
test/unit, test/integration
```

## Production notes
- Run **one or more** app instances. All of them run pg-boss workers, and the engine is safe
  under concurrency.
- Put the app behind HTTPS and set `PUBLIC_BASE_URL` to the `https://` URL.
- Sessions are signed cookies (12 hours). Changing a user's role or deactivating them takes
  effect on their next request.
- POST requests from other origins are rejected (`Origin` check, plus `SameSite=Lax` cookies).

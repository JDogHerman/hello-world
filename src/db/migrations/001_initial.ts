import { Kysely, sql } from 'kysely';

/**
 * Initial schema. All instants are timestamptz (stored UTC); the configured
 * local timezone is applied only when parsing form input and rendering.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE app_config (
      id                     smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      reply_window_minutes   integer  NOT NULL DEFAULT 60  CHECK (reply_window_minutes BETWEEN 1 AND 1440),
      offers_per_open_slot   integer  NOT NULL DEFAULT 1   CHECK (offers_per_open_slot BETWEEN 1 AND 20),
      quiet_hours_start      time     NOT NULL DEFAULT '21:00',
      quiet_hours_end        time     NOT NULL DEFAULT '08:00',
      timezone               text     NOT NULL DEFAULT 'America/New_York',
      local_name             text     NOT NULL DEFAULT 'Local 123',
      booking_buffer_minutes integer  NOT NULL DEFAULT 0   CHECK (booking_buffer_minutes BETWEEN 0 AND 720),
      steward_sms_alerts     boolean  NOT NULL DEFAULT false,
      updated_at             timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO app_config (id) VALUES (1);

    CREATE TABLE app_user (
      id            serial PRIMARY KEY,
      email         text NOT NULL UNIQUE,
      name          text NOT NULL,
      password_hash text NOT NULL,
      role          text NOT NULL CHECK (role IN ('admin', 'steward')),
      phone         text,
      active        boolean NOT NULL DEFAULT true,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE worker (
      id           serial PRIMARY KEY,
      first_name   text NOT NULL,
      last_name    text NOT NULL,
      phone        text NOT NULL UNIQUE CHECK (phone ~ '^\\+[1-9][0-9]{6,14}$'),
      tranche      integer NOT NULL CHECK (tranche >= 1),
      start_date   date NOT NULL,
      active       boolean NOT NULL DEFAULT true,
      sms_opt_out  boolean NOT NULL DEFAULT false,
      opt_out_at   timestamptz,
      notes        text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX worker_name_idx ON worker (last_name, first_name);

    CREATE TABLE skill (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      active     boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE job_type (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      active     boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE venue (
      id         serial PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      address    text NOT NULL DEFAULT '',
      active     boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE worker_skill (
      worker_id integer NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
      skill_id  integer NOT NULL REFERENCES skill(id),
      PRIMARY KEY (worker_id, skill_id)
    );

    CREATE TABLE worker_refusal (
      id          serial PRIMARY KEY,
      worker_id   integer NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
      job_type_id integer REFERENCES job_type(id),
      venue_id    integer REFERENCES venue(id),
      reason      text NOT NULL DEFAULT '',
      created_at  timestamptz NOT NULL DEFAULT now(),
      CHECK ((job_type_id IS NULL) <> (venue_id IS NULL))
    );
    CREATE UNIQUE INDEX worker_refusal_job_type_uq ON worker_refusal (worker_id, job_type_id) WHERE job_type_id IS NOT NULL;
    CREATE UNIQUE INDEX worker_refusal_venue_uq    ON worker_refusal (worker_id, venue_id)    WHERE venue_id IS NOT NULL;

    CREATE TABLE worker_unavailability (
      id         serial PRIMARY KEY,
      worker_id  integer NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
      starts_at  timestamptz NOT NULL,
      ends_at    timestamptz NOT NULL,
      note       text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (ends_at > starts_at)
    );
    CREATE INDEX worker_unavailability_worker_idx ON worker_unavailability (worker_id, starts_at);

    CREATE TABLE job (
      id           serial PRIMARY KEY,
      venue_id     integer NOT NULL REFERENCES venue(id),
      job_type_id  integer NOT NULL REFERENCES job_type(id),
      starts_at    timestamptz NOT NULL,
      est_end_at   timestamptz NOT NULL,
      notes        text NOT NULL DEFAULT '',
      status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'cancelled', 'complete')),
      created_by   integer REFERENCES app_user(id),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (est_end_at > starts_at)
    );
    CREATE INDEX job_starts_idx ON job (starts_at);

    CREATE TABLE position (
      id           serial PRIMARY KEY,
      job_id       integer NOT NULL REFERENCES job(id) ON DELETE CASCADE,
      skill_id     integer NOT NULL REFERENCES skill(id),
      quantity     integer NOT NULL CHECK (quantity >= 1),
      filled_count integer NOT NULL DEFAULT 0,
      status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'exhausted', 'cancelled')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CHECK (filled_count BETWEEN 0 AND quantity)
    );
    CREATE INDEX position_job_idx ON position (job_id);

    CREATE TABLE candidate_list (
      id            serial PRIMARY KEY,
      position_id   integer NOT NULL UNIQUE REFERENCES position(id) ON DELETE CASCADE,
      status        text NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'pending_approval', 'approved', 'active', 'filled', 'exhausted', 'cancelled')),
      generated_at  timestamptz NOT NULL DEFAULT now(),
      approved_by   integer REFERENCES app_user(id),
      approved_at   timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE candidate_entry (
      id             serial PRIMARY KEY,
      list_id        integer NOT NULL REFERENCES candidate_list(id) ON DELETE CASCADE,
      worker_id      integer NOT NULL REFERENCES worker(id),
      rank           integer NOT NULL,
      source         text NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
      removed_at     timestamptz,
      removed_reason text,
      skipped_reasons text[],
      created_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE (list_id, worker_id)
    );
    CREATE INDEX candidate_entry_rank_idx ON candidate_entry (list_id, rank);

    CREATE TABLE candidate_exclusion (
      list_id   integer NOT NULL REFERENCES candidate_list(id) ON DELETE CASCADE,
      worker_id integer NOT NULL REFERENCES worker(id) ON DELETE CASCADE,
      reasons   text[] NOT NULL,
      PRIMARY KEY (list_id, worker_id)
    );

    CREATE TABLE offer (
      id                 serial PRIMARY KEY,
      position_id        integer NOT NULL REFERENCES position(id) ON DELETE CASCADE,
      worker_id          integer NOT NULL REFERENCES worker(id),
      candidate_entry_id integer REFERENCES candidate_entry(id) ON DELETE SET NULL,
      code               char(4) NOT NULL,
      status             text NOT NULL CHECK (status IN ('queued', 'sent', 'accepted', 'declined', 'expired', 'cancelled')),
      queued_at          timestamptz NOT NULL DEFAULT now(),
      sent_at            timestamptz,
      expires_at         timestamptz,
      responded_at       timestamptz,
      reply_text         text,
      cancel_reason      text,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      CHECK (status <> 'sent' OR (sent_at IS NOT NULL AND expires_at IS NOT NULL))
    );
    -- A worker can only receive each position once.
    CREATE UNIQUE INDEX offer_position_worker_uq ON offer (position_id, worker_id);
    -- Codes are unique among a worker's open offers so replies match unambiguously.
    CREATE UNIQUE INDEX offer_open_code_uq ON offer (worker_id, code) WHERE status IN ('queued', 'sent');
    CREATE INDEX offer_status_expires_idx ON offer (status, expires_at);
    CREATE INDEX offer_worker_idx ON offer (worker_id, created_at DESC);

    CREATE TABLE booking (
      id            serial PRIMARY KEY,
      worker_id     integer NOT NULL REFERENCES worker(id),
      job_id        integer NOT NULL REFERENCES job(id) ON DELETE CASCADE,
      position_id   integer NOT NULL REFERENCES position(id) ON DELETE CASCADE,
      offer_id      integer REFERENCES offer(id),
      starts_at     timestamptz NOT NULL,
      ends_at       timestamptz NOT NULL,
      cancelled_at  timestamptz,
      cancel_reason text,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX booking_worker_idx ON booking (worker_id, starts_at) WHERE cancelled_at IS NULL;
    CREATE UNIQUE INDEX booking_worker_job_uq ON booking (worker_id, job_id) WHERE cancelled_at IS NULL;

    CREATE TABLE sms_message (
      id            serial PRIMARY KEY,
      direction     text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
      worker_id     integer REFERENCES worker(id) ON DELETE SET NULL,
      phone         text NOT NULL,
      body          text NOT NULL,
      offer_id      integer REFERENCES offer(id) ON DELETE SET NULL,
      provider_sid  text UNIQUE,
      -- outbound: pending -> sending -> sent | failed; inbound: received
      status        text NOT NULL,
      not_before    timestamptz NOT NULL DEFAULT now(),
      attempts      integer NOT NULL DEFAULT 0,
      error         text,
      sent_at       timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX sms_outbox_idx ON sms_message (not_before) WHERE status = 'pending';
    CREATE INDEX sms_worker_idx ON sms_message (worker_id, created_at DESC);

    CREATE TABLE alert (
      id              serial PRIMARY KEY,
      kind            text NOT NULL,
      job_id          integer REFERENCES job(id) ON DELETE CASCADE,
      position_id     integer REFERENCES position(id) ON DELETE CASCADE,
      message         text NOT NULL,
      acknowledged_by integer REFERENCES app_user(id),
      acknowledged_at timestamptz,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX alert_open_idx ON alert (created_at DESC) WHERE acknowledged_at IS NULL;

    CREATE TABLE audit_log (
      id          bigserial PRIMARY KEY,
      at          timestamptz NOT NULL DEFAULT now(),
      actor_type  text NOT NULL CHECK (actor_type IN ('user', 'worker', 'system')),
      actor_id    integer,
      actor_label text NOT NULL DEFAULT '',
      action      text NOT NULL,
      entity      text NOT NULL,
      entity_id   integer,
      reason      text,
      data        jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX audit_at_idx ON audit_log (at DESC);
    CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS audit_log, alert, sms_message, booking, offer, candidate_exclusion,
      candidate_entry, candidate_list, position, job, worker_unavailability, worker_refusal,
      worker_skill, venue, job_type, skill, worker, app_user, app_config CASCADE;
  `.execute(db);
}

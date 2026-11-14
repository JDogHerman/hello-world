import { Kysely, sql } from 'kysely';

/**
 * Short tag put at the start of every text (e.g. "[IA48] Work call: ..."), separate from the
 * full union name shown in the app. Kept short because every character counts toward SMS segments.
 */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE app_config ADD COLUMN sms_prefix text NOT NULL DEFAULT 'IA48'
      CHECK (length(sms_prefix) BETWEEN 1 AND 20);
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE app_config DROP COLUMN sms_prefix;`.execute(db);
}

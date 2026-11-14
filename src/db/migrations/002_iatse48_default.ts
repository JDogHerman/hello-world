import { Kysely, sql } from 'kysely';

/** Sets the union name used as the prefix on every text. Still editable on the Settings page. */
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE app_config ALTER COLUMN local_name SET DEFAULT 'IATSE 48 Akron/Canton';
    UPDATE app_config SET local_name = 'IATSE 48 Akron/Canton' WHERE local_name = 'Local 123';
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE app_config ALTER COLUMN local_name SET DEFAULT 'Local 123';`.execute(db);
}

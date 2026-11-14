import pg from 'pg';
import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import type { Database } from './types.js';

// Return Postgres `date` columns as plain 'YYYY-MM-DD' strings instead of JS Dates
// (a date has no timezone; converting it to a Date invites off-by-one bugs).
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
// bigint (audit_log.id) as string is the pg default; counts come back as strings too.

export type DB = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Either the root connection or an open transaction. */
export type Executor = Kysely<Database> | Transaction<Database>;

export function createDb(connectionString: string, max = 10): DB {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString, max }),
    }),
  });
}

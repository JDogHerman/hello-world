import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { DB } from './kysely.js';
import * as m001 from './migrations/001_initial.js';

// Migrations are registered explicitly (rather than read from disk) so the same
// code works from `src` under tsx and from `dist` after compilation.
const migrations: Record<string, Migration> = {
  '001_initial': m001,
};

class StaticProvider implements MigrationProvider {
  async getMigrations() {
    return migrations;
  }
}

export async function migrateToLatest(db: DB): Promise<void> {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === 'Success') console.log(`migration "${r.migrationName}" applied`);
    else if (r.status === 'Error') console.error(`migration "${r.migrationName}" failed`);
  }
  if (error) throw error;
}

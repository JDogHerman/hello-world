import { loadEnv } from '../env.js';
import { createDb } from './kysely.js';
import { migrateToLatest } from './migrator.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
try {
  await migrateToLatest(db);
  console.log('database is up to date');
} finally {
  await db.destroy();
}

import { loadEnv } from './env.js';
import { createDb } from './db/kysely.js';
import { migrateToLatest } from './db/migrator.js';
import { createSmsProvider } from './sms/index.js';
import { noopScheduler, systemClock, type AppContext } from './services/context.js';
import './services/offerEngine.js';
import { startJobs } from './jobs/boss.js';
import { buildServer } from './web/server.js';

const env = loadEnv();
const db = createDb(env.DATABASE_URL);
await migrateToLatest(db);

const ctx: AppContext = {
  db,
  sms: createSmsProvider(env),
  clock: systemClock,
  scheduler: noopScheduler,
  defaultRegion: env.DEFAULT_PHONE_REGION,
  log: console,
};

const { boss, scheduler } = await startJobs(env.DATABASE_URL, () => ctx);
ctx.scheduler = scheduler;

const app = await buildServer({ ctx, env });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
console.log(`Stagehand scheduler listening on http://localhost:${env.PORT} (SMS provider: ${ctx.sms.name})`);

const shutdown = async () => {
  await app.close();
  await boss.stop();
  await db.destroy();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

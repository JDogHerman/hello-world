import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/stagehand'),
  PORT: z.coerce.number().int().default(3000),
  SESSION_SECRET: z.string().min(16).default('dev-only-secret-change-me-please-0123456789'),
  PUBLIC_BASE_URL: z.string().default('http://localhost:3000'),
  SMS_PROVIDER: z.enum(['console', 'twilio']).default('console'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  TWILIO_VALIDATE_SIGNATURE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  DEFAULT_PHONE_REGION: z.string().length(2).default('US'),
  NODE_ENV: z.string().default('development'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Reads process.env (after an optional .env file) and validates it. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env file: fine */
  }
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ''));
  const env = EnvSchema.parse(cleaned);
  if (env.SMS_PROVIDER === 'twilio') {
    const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'].filter((k) => !cleaned[k]);
    if (!cleaned.TWILIO_FROM_NUMBER && !cleaned.TWILIO_MESSAGING_SERVICE_SID) {
      missing.push('TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID');
    }
    if (missing.length) throw new Error(`SMS_PROVIDER=twilio requires: ${missing.join(', ')}`);
  }
  if (env.NODE_ENV === 'production' && env.SESSION_SECRET.startsWith('dev-only')) {
    throw new Error('Set SESSION_SECRET in production');
  }
  return env;
}

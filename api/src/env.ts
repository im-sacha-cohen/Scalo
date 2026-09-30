// Environment loading & validation. Imported first by every entry point (server, seed, migrations, tests).
// Values already present in the process environment win over the repo-root `.env` file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
for (const file of [path.resolve(here, '../../.env'), path.resolve(here, '../.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

const DEFAULT_SECRET = 'change-me';
const bool = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', ''])
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes'].includes(v)));

/** TRUST_PROXY → value for `app.set('trust proxy', …)`. */
function parseTrustProxy(v: string | undefined): boolean | number | string {
  const t = (v ?? '').trim();
  if (!t || ['0', 'false', 'no', 'off'].includes(t.toLowerCase())) return false;
  if (['true', 'yes', 'on'].includes(t.toLowerCase())) return true;
  if (/^\d+$/.test(t)) return Number(t);
  return t;
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis (ex. postgres://scalo:scalo_dev_password@localhost:5433/scalo)'),
    TEST_DATABASE_URL: z.string().optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
    DATABASE_SSL: bool,
    JWT_SECRET: z.string().min(1).default(DEFAULT_SECRET),
    API_PORT: z.coerce.number().int().min(0).max(65535).default(4000),
    PUBLIC_URL: z.string().default('http://localhost:5173'),
    AUTO_MIGRATE: bool,
    // Self-hosting: `false` closes public sign-ups (POST /api/auth/register) as soon as one account exists — the very
    // first account of an empty instance can always be created. Default: open.
    ALLOW_SIGNUPS: bool,
    // Express `trust proxy`: unset/false = req.ip is the socket address. `true`, a hop count (1) or a list of
    // addresses/subnets ('loopback', '10.0.0.0/8') when running behind a reverse proxy / load balancer.
    TRUST_PROXY: z.string().optional(),
    // Custom domains (funnels): extra host names of the app itself (comma separated), and the CNAME target given to
    // users (default: host of PUBLIC_URL). Any other host is only served if it is a verified custom domain.
    APP_HOSTS: z.string().optional(),
    CUSTOM_DOMAIN_TARGET: z.string().optional(),
    // AI (Claude API): instance-wide key (accounts can also store their own in Settings → IA), model, limits.
    ANTHROPIC_API_KEY: z.string().optional(),
    AI_MODEL: z.string().trim().min(1).default('claude-opus-5-5'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(900_000).default(180_000),
    AI_RATE_LIMIT_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(30),
    // (ENCRYPTION_KEY — secrets stored encrypted in the database — is read by services/secretbox.ts; default: JWT_SECRET.)
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && (e.JWT_SECRET === DEFAULT_SECRET || e.JWT_SECRET === 'dev-secret-change-me' || e.JWT_SECRET.length < 32)) {
      ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'doit être une valeur aléatoire d’au moins 32 caractères en production' });
    }
  });

// `npm test` sets NODE_ENV=test: the suite always runs against TEST_DATABASE_URL, never the dev database.
if (process.env.NODE_ENV === 'test') {
  if (!process.env.TEST_DATABASE_URL) {
    console.error('[env] TEST_DATABASE_URL est requis pour lancer les tests');
    process.exit(1);
  }
  if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
    console.error('[env] TEST_DATABASE_URL doit être différent de DATABASE_URL (les tests vident la base)');
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Configuration invalide :');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  TRUST_PROXY: parseTrustProxy(parsed.data.TRUST_PROXY),
  // Migrations run at startup unless AUTO_MIGRATE=false (default: on, except in production where it must be explicit).
  AUTO_MIGRATE: parsed.data.AUTO_MIGRATE ?? parsed.data.NODE_ENV !== 'production',
  ALLOW_SIGNUPS: parsed.data.ALLOW_SIGNUPS ?? true,
  PUBLIC_URL: parsed.data.PUBLIC_URL.replace(/\/+$/, ''),
};

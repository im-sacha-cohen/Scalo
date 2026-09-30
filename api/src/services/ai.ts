// Native AI: API key resolution ("bring your own key"), per-account rate limit, usage log and asynchronous generations.
import { sql } from 'kysely';
import type { z } from 'zod';
import { db, nowIso, type AiGenerationKind } from '../db';
import { env } from '../env';
import { HttpError } from '../util';
import { AiError, AI_ERROR_MESSAGES, anthropicTransport, type AiEffort, type AiTransport } from './ai-client';
import { hit, type Limit } from './ratelimit';
import { decryptSecret, encryptSecret } from './secretbox';

export interface AiOptions {
  /** Claude API transport (tests inject a fake one: no network). */
  transport?: AiTransport;
  /** Instance-wide key; default: ANTHROPIC_API_KEY. `null` = none. */
  instanceKey?: string | null;
  /** AI calls per account and window; default: AI_RATE_LIMIT_PER_HOUR per hour. */
  rateLimit?: Limit;
  timeoutMs?: number;
  model?: string;
}

export interface AiDeps {
  transport: AiTransport;
  instanceKey: string | null;
  rateLimit: Limit;
  timeoutMs: number;
  model: string;
}

export const aiDeps = (o: AiOptions = {}): AiDeps => ({
  transport: o.transport ?? anthropicTransport,
  instanceKey: o.instanceKey !== undefined ? o.instanceKey : env.ANTHROPIC_API_KEY?.trim() || null,
  rateLimit: o.rateLimit ?? { max: env.AI_RATE_LIMIT_PER_HOUR, windowMs: 3600_000 },
  timeoutMs: o.timeoutMs ?? env.AI_TIMEOUT_MS,
  model: o.model ?? env.AI_MODEL,
});

// ---------- API key ----------

const KEY_PURPOSE = 'ai.anthropic_api_key';

export async function saveAccountKey(userId: number, apiKey: string) {
  const enc = encryptSecret(apiKey, KEY_PURPOSE);
  const hint = apiKey.slice(-4);
  await db
    .insertInto('ai_settings')
    .values({ user_id: userId, api_key_enc: enc, key_hint: hint, updated_at: nowIso() })
    .onConflict((oc) => oc.column('user_id').doUpdateSet({ api_key_enc: enc, key_hint: hint, updated_at: nowIso() }))
    .execute();
}

export async function deleteAccountKey(userId: number) {
  await db.deleteFrom('ai_settings').where('user_id', '=', userId).execute();
}

/** The account's own key wins over the instance key. */
async function resolveKey(userId: number, deps: AiDeps): Promise<{ key: string; source: 'account' | 'instance' } | null> {
  const row = await db.selectFrom('ai_settings').select('api_key_enc').where('user_id', '=', userId).executeTakeFirst();
  if (row) {
    const key = decryptSecret(row.api_key_enc, KEY_PURPOSE);
    // unreadable (ENCRYPTION_KEY / JWT_SECRET changed): treated as an invalid key, the user enters it again
    if (!key) throw new HttpError(409, 'Votre clé API Claude n’est plus lisible (le secret de chiffrement du serveur a changé). Saisissez-la à nouveau dans Paramètres → IA.');
    return { key, source: 'account' };
  }
  return deps.instanceKey ? { key: deps.instanceKey, source: 'instance' } : null;
}

export async function aiStatus(userId: number, deps: AiDeps) {
  const row = await db.selectFrom('ai_settings').select(['key_hint', 'updated_at']).where('user_id', '=', userId).executeTakeFirst();
  return {
    configured: !!row || !!deps.instanceKey,
    source: row ? ('account' as const) : deps.instanceKey ? ('instance' as const) : null,
    key_hint: row?.key_hint ?? null,
    key_updated_at: row?.updated_at ?? null,
    model: deps.model,
    rate_limit: { max: deps.rateLimit.max, window_minutes: Math.round(deps.rateLimit.windowMs / 60_000) },
  };
}

// ---------- running a generation ----------

export interface AiTask<T> {
  kind: AiGenerationKind;
  /** Short description shown in the usage log (never the full brief). */
  label: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  maxTokens: number;
  effort: AiEffort;
}

interface Started {
  id: number;
  key: string;
}

/** Key check, rate limit, then the `running` row. Throws the HTTP error shown to the user. */
async function start(userId: number, deps: AiDeps, task: Pick<AiTask<unknown>, 'kind' | 'label'>): Promise<Started> {
  const k = await resolveKey(userId, deps);
  if (!k) throw new HttpError(409, AI_ERROR_MESSAGES.not_configured);
  const r = await hit(`ai:${userId}`, deps.rateLimit);
  if (r.blocked) {
    const minutes = Math.max(1, Math.ceil(r.retryAfter / 60));
    throw new HttpError(429, `Limite de ${deps.rateLimit.max} générations IA atteinte. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`);
  }
  const row = await db
    .insertInto('ai_generations')
    .values({ user_id: userId, kind: task.kind, label: task.label.slice(0, 200), model: deps.model, key_source: k.source, created_at: nowIso() })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id: row.id, key: k.key };
}

/** Calls the model and validates its answer. Throws AiError (with the tokens already consumed). */
async function call<T>(deps: AiDeps, key: string, task: AiTask<T>): Promise<{ data: T; inputTokens: number; outputTokens: number; model: string }> {
  let res;
  try {
    res = await deps.transport({ apiKey: key, model: deps.model, system: task.system, prompt: task.prompt, schema: task.schema, maxTokens: task.maxTokens, effort: task.effort, timeoutMs: deps.timeoutMs });
  } catch (e) {
    throw e instanceof AiError ? e : new AiError('unavailable');
  }
  const usage = { inputTokens: res.inputTokens, outputTokens: res.outputTokens, model: res.model };
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw new AiError('invalid_output', usage);
  }
  const parsed = task.schema.safeParse(json);
  if (!parsed.success) throw new AiError('invalid_output', usage);
  return { data: parsed.data, ...usage };
}

async function finish(id: number, r: { result?: Record<string, unknown>; error?: string; inputTokens: number; outputTokens: number; model?: string }) {
  await db
    .updateTable('ai_generations')
    .set({
      status: r.error ? 'failed' : 'done',
      result: r.result ? JSON.stringify(r.result) : null,
      error: r.error ?? null,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      ...(r.model ? { model: r.model } : {}),
      finished_at: nowIso(),
    })
    .where('id', '=', id)
    .execute();
}

const failure = (e: unknown) => {
  if (e instanceof AiError) return { error: e.message, inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, model: e.usage.model };
  // `apply` failed (database…): log the message only, never the prompt or the key
  console.error('[ai] generation failed:', (e as Error)?.message);
  return { error: 'La génération a échoué. Réessayez.', inputTokens: 0, outputTokens: 0 };
};

const inFlight = new Set<Promise<void>>();
/** Resolves when every background generation has settled (graceful shutdown, tests). */
export const aiIdle = () => Promise.allSettled([...inFlight]).then(() => undefined);

/**
 * Asynchronous generation: returns the id of the `running` row at once; the model call and `apply` (which creates the
 * funnel / campaign / newsletter and returns what is stored in `result`) run in the background. The app polls
 * GET /api/ai/generations/:id.
 */
export async function startGeneration<T>(userId: number, deps: AiDeps, task: AiTask<T>, apply: (data: T) => Promise<Record<string, unknown>>): Promise<number> {
  const { id, key } = await start(userId, deps, task);
  const p = (async () => {
    try {
      const r = await call(deps, key, task);
      try {
        await finish(id, { result: await apply(r.data), inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model });
      } catch (e) {
        await finish(id, { ...failure(e), inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model });
      }
    } catch (e) {
      await finish(id, failure(e)).catch((err) => console.error('[ai] could not record the failure:', (err as Error).message));
    }
  })();
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return id;
}

const HTTP_STATUS: Partial<Record<string, number>> = { invalid_key: 409, quota: 402, rate_limited: 429, refused: 422, timeout: 504, bad_request: 502, unavailable: 503 };

/** Synchronous (short) generation: rewrite, subject ideas. Logged like the others. */
export async function runNow<T>(userId: number, deps: AiDeps, task: AiTask<T>): Promise<T> {
  const { id, key } = await start(userId, deps, task);
  try {
    const r = await call(deps, key, task);
    await finish(id, { result: {}, inputTokens: r.inputTokens, outputTokens: r.outputTokens, model: r.model });
    return r.data;
  } catch (e) {
    await finish(id, failure(e));
    if (e instanceof AiError) throw new HttpError(HTTP_STATUS[e.code] ?? 502, e.message);
    throw e;
  }
}

// ---------- reading ----------

const COLUMNS = ['id', 'kind', 'status', 'label', 'result', 'error', 'model', 'key_source', 'input_tokens', 'output_tokens', 'created_at', 'finished_at'] as const;

/** A generation left `running` by a process that stopped is reported as failed once its deadline has passed. */
async function expireStale(userId: number, deps: AiDeps) {
  const secs = Math.ceil(deps.timeoutMs / 1000) + 120;
  await db
    .updateTable('ai_generations')
    .set({ status: 'failed', error: 'La génération a été interrompue. Réessayez.', finished_at: nowIso() })
    .where('user_id', '=', userId)
    .where('status', '=', 'running')
    .where('created_at', '<', sql<string>`now() - make_interval(secs => ${secs})`)
    .execute();
}

export async function getGeneration(userId: number, id: number, deps: AiDeps) {
  await expireStale(userId, deps);
  return db.selectFrom('ai_generations').select(COLUMNS).where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
}

export async function usage(userId: number, deps: AiDeps) {
  await expireStale(userId, deps);
  const since = sql<string>`now() - interval '30 days'`;
  const [items, totals] = await Promise.all([
    db.selectFrom('ai_generations').select(COLUMNS).where('user_id', '=', userId).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(50).execute(),
    db
      .selectFrom('ai_generations')
      .select((eb) => [eb.fn.countAll<number>().as('calls'), eb.fn.coalesce(eb.fn.sum<number>('input_tokens'), sql<number>`0`).as('input_tokens'), eb.fn.coalesce(eb.fn.sum<number>('output_tokens'), sql<number>`0`).as('output_tokens')])
      .where('user_id', '=', userId)
      .where('created_at', '>=', since)
      .executeTakeFirstOrThrow(),
  ]);
  return { last_30_days: { calls: Number(totals.calls), input_tokens: Number(totals.input_tokens), output_tokens: Number(totals.output_tokens) }, items };
}

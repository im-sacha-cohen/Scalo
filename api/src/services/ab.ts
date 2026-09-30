// A/B tests of funnel pages. The step's own content is the original (arm 0); step_variants are the other arms.
// A visitor is assigned once (sticky cookie `scalo_ab_<stepId>`, scoped to the funnel) proportionally to the weights.
// The arm is stored on the unique page view and on the optin event; stats compare every arm with the original
// (two-proportion z-test, reported cautiously).
import type { Request, Response } from 'express';
import { sql } from 'kysely';
import type { AbArmStats, PageContent, StepAbTest, StepVariant } from '@scalo/shared';
import { db, type Db } from '../db';

export const MAX_VARIANTS = 4;
const COOKIE_MAX_AGE = 90 * 86400_000;
export const armCookie = (stepId: number) => `scalo_ab_${stepId}`;

interface AbStep {
  id: number;
  content: PageContent;
  ab_status: 'off' | 'running' | 'paused';
  ab_control_weight: number;
}

/** Weighted random pick. All weights 0 → even split. */
export function pickArm(arms: { id: number; weight: number }[], rand = Math.random): number {
  const total = arms.reduce((a, x) => a + Math.max(0, x.weight), 0);
  if (!arms.length) return 0;
  if (total <= 0) return arms[Math.floor(rand() * arms.length)]!.id;
  let r = rand() * total;
  for (const a of arms) {
    r -= Math.max(0, a.weight);
    if (r < 0) return a.id;
  }
  return arms[arms.length - 1]!.id;
}

function activeVariants(stepId: number, ex: Db = db) {
  return ex
    .selectFrom('step_variants')
    .select(['id', 'name', 'weight', 'content'])
    .where('step_id', '=', stepId)
    .where('active', '=', true)
    .orderBy('id')
    .execute();
}

export interface ArmChoice {
  /** 0 = original, a variant id, or null when no test is running (nothing to attribute). */
  variantId: number | null;
  content: PageContent;
}

const cookieArm = (req: Request, stepId: number): number | null => {
  const v = req.cookies?.[armCookie(stepId)];
  return typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null;
};

/**
 * Content to show for a page view. Owner preview may force an arm with `?variant=<id>` (`0` = original).
 * Running test: sticky assignment (cookie), new visitors split by weight.
 */
export async function chooseArm(req: Request, res: Response, step: AbStep, cookiePath: string, ownerPreview: boolean): Promise<ArmChoice> {
  const forced = typeof req.query.variant === 'string' && /^\d{1,15}$/.test(req.query.variant) ? Number(req.query.variant) : null;
  if (ownerPreview && forced !== null) {
    if (forced === 0) return { variantId: null, content: step.content };
    const v = await db.selectFrom('step_variants').select('content').where('id', '=', forced).where('step_id', '=', step.id).executeTakeFirst();
    return { variantId: null, content: v?.content ?? step.content };
  }
  if (step.ab_status !== 'running') return { variantId: null, content: step.content };
  const variants = await activeVariants(step.id);
  if (!variants.length) return { variantId: null, content: step.content };
  let arm = cookieArm(req, step.id);
  if (arm === null || (arm !== 0 && !variants.some((v) => v.id === arm))) {
    arm = pickArm([{ id: 0, weight: step.ab_control_weight }, ...variants.map((v) => ({ id: v.id, weight: v.weight }))]);
    res.cookie(armCookie(step.id), String(arm), { httpOnly: true, sameSite: 'lax', maxAge: COOKIE_MAX_AGE, path: cookiePath });
  }
  const v = variants.find((x) => x.id === arm);
  return { variantId: arm, content: v?.content ?? step.content };
}

/** Arm of a form submission: the visitor's assigned arm while the test is running (the form config comes from it). */
export async function submitArm(req: Request, step: AbStep): Promise<ArmChoice> {
  if (step.ab_status !== 'running') return { variantId: null, content: step.content };
  const arm = cookieArm(req, step.id);
  if (arm === null) return { variantId: null, content: step.content };
  if (arm === 0) return { variantId: 0, content: step.content };
  const v = await db.selectFrom('step_variants').select('content').where('id', '=', arm).where('step_id', '=', step.id).where('active', '=', true).executeTakeFirst();
  return v ? { variantId: arm, content: v.content } : { variantId: null, content: step.content };
}

// ---------- stats ----------

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf approximation, |error| < 1.5e-7). */
function phi(z: number) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/** Two-sided p-value of the two-proportion z-test (pooled). null when it cannot be computed. */
export function twoProportionPValue(c1: number, n1: number, c2: number, n2: number): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = (c2 / n2 - c1 / n1) / se;
  return Math.min(1, Math.max(0, 2 * (1 - phi(Math.abs(z)))));
}

export const MIN_VISITORS_PER_ARM = 100;
export const MIN_TOTAL_OPTINS = 10;

export const toVariant = (r: { id: number; step_id: number; name: string; weight: number; active: boolean; created_at: string }): StepVariant => ({
  id: r.id,
  step_id: r.step_id,
  name: r.name,
  weight: r.weight,
  active: r.active,
  created_at: r.created_at,
});

export async function abTestOf(step: { id: number; ab_status: 'off' | 'running' | 'paused'; ab_control_weight: number; ab_started_at: string | null }): Promise<StepAbTest> {
  const variants = await db.selectFrom('step_variants').select(['id', 'step_id', 'name', 'weight', 'active', 'created_at']).where('step_id', '=', step.id).orderBy('id').execute();
  const [{ rows: views }, { rows: optins }] = await Promise.all([
    sql<{ variant_id: number; n: number }>`
      SELECT variant_id, COUNT(*) AS n FROM page_views WHERE step_id = ${step.id} AND variant_id IS NOT NULL GROUP BY variant_id`.execute(db),
    sql<{ variant_id: number; n: number }>`
      SELECT variant_id, COUNT(DISTINCT contact_id) AS n FROM contact_events
       WHERE step_id = ${step.id} AND type = 'optin' AND variant_id IS NOT NULL GROUP BY variant_id`.execute(db),
  ]);
  const count = (rows: { variant_id: number; n: number }[], id: number) => Number(rows.find((r) => Number(r.variant_id) === id)?.n ?? 0);
  const base = { visitors: count(views, 0), optins: count(optins, 0) };
  const rate = (o: number, v: number) => (v ? o / v : 0);
  const rate0 = rate(base.optins, base.visitors);
  const arms: AbArmStats[] = [
    { variant_id: 0, name: 'Original', weight: step.ab_control_weight, active: true, ...base, rate: rate0, lift: null, p_value: null, significant: false },
    ...variants.map((v) => {
      const visitors = count(views, v.id);
      const o = count(optins, v.id);
      const r = rate(o, visitors);
      const p = twoProportionPValue(base.optins, base.visitors, o, visitors);
      return {
        variant_id: v.id,
        name: v.name,
        weight: v.weight,
        active: v.active,
        visitors,
        optins: o,
        rate: r,
        lift: rate0 > 0 && visitors > 0 ? (r - rate0) / rate0 : null,
        p_value: p,
        significant: p !== null && p < 0.05 && visitors >= MIN_VISITORS_PER_ARM && base.visitors >= MIN_VISITORS_PER_ARM && o + base.optins >= MIN_TOTAL_OPTINS,
      };
    }),
  ];
  return { step_id: step.id, status: step.ab_status, control_weight: step.ab_control_weight, started_at: step.ab_started_at, variants: variants.map(toVariant), arms };
}

/** A new test starts from zero: the arms recorded by a previous test of this step are forgotten. */
export async function resetAbAttribution(stepId: number, ex: Db) {
  await ex.updateTable('page_views').set({ variant_id: null }).where('step_id', '=', stepId).where('variant_id', 'is not', null).execute();
  await ex.updateTable('contact_events').set({ variant_id: null }).where('step_id', '=', stepId).where('variant_id', 'is not', null).execute();
}

// Conversion stats of a funnel by source / medium / campaign / referrer / A/B variant, over a period.
// Visitors = unique visitors (page_views is unique per step and visitor), optins = optin events. Every page view and
// optin event carries the visitor's first-touch attribution, so a visitor keeps the same source on every step.
import { sql, type RawBuilder } from 'kysely';
import type { FunnelStats, FunnelStatsRow, StatsGroup, StatsPeriod } from '@scalo/shared';
import { db } from '../db';

const DIRECT = '(direct)';
const NONE = '(aucun)';

/** Group key of a page view (column names are fixed here, never taken from the request). */
function viewKey(group: StatsGroup): RawBuilder<string> {
  switch (group) {
    case 'source':
      return sql<string>`COALESCE(NULLIF(v.utm_source, ''), v.referrer_host, ${DIRECT})`;
    case 'medium':
      return sql<string>`COALESCE(NULLIF(v.utm_medium, ''), CASE WHEN v.referrer_host IS NOT NULL THEN 'referral' END, ${NONE})`;
    case 'campaign':
      return sql<string>`COALESCE(NULLIF(v.utm_campaign, ''), ${NONE})`;
    case 'referrer':
      return sql<string>`COALESCE(v.referrer_host, ${DIRECT})`;
    case 'variant':
      return sql<string>`v.step_id::text || ':' || v.variant_id::text`;
  }
}

function eventKey(group: StatsGroup): RawBuilder<string> {
  const a = (k: string) => sql`NULLIF(e.attribution->>${k}, '')`;
  switch (group) {
    case 'source':
      return sql<string>`COALESCE(${a('utm_source')}, ${a('referrer')}, ${DIRECT})`;
    case 'medium':
      return sql<string>`COALESCE(${a('utm_medium')}, CASE WHEN ${a('referrer')} IS NOT NULL THEN 'referral' END, ${NONE})`;
    case 'campaign':
      return sql<string>`COALESCE(${a('utm_campaign')}, ${NONE})`;
    case 'referrer':
      return sql<string>`COALESCE(${a('referrer')}, ${DIRECT})`;
    case 'variant':
      return sql<string>`e.step_id::text || ':' || e.variant_id::text`;
  }
}

const rate = (o: number, v: number) => (v > 0 ? o / v : 0);
export const PERIODS: StatsPeriod[] = ['7', '30', '90', 'all'];
export const GROUPS: StatsGroup[] = ['source', 'medium', 'campaign', 'referrer', 'variant'];

export async function funnelStats(funnelId: number, period: StatsPeriod, group: StatsGroup): Promise<FunnelStats> {
  const since = period === 'all' ? null : new Date(Date.now() - Number(period) * 86400_000).toISOString();
  const vSince = since ? sql`AND v.created_at >= ${since}` : sql``;
  const eSince = since ? sql`AND e.created_at >= ${since}` : sql``;
  const vVariant = group === 'variant' ? sql`AND v.variant_id IS NOT NULL` : sql``;
  const eVariant = group === 'variant' ? sql`AND e.variant_id IS NOT NULL` : sql``;
  // daily chart: the period, at most 90 days
  const dailyDays = period === 'all' ? 90 : Number(period);
  const dailySince = new Date(Date.now() - (dailyDays - 1) * 86400_000).toISOString().slice(0, 10);

  const [steps, variants, totalsV, totalsE, perStepV, perStepE, rowsV, rowsVSteps, rowsE, dailyV, dailyE] = await Promise.all([
    db.selectFrom('steps').select(['id', 'name']).where('funnel_id', '=', funnelId).orderBy('position').orderBy('id').execute(),
    db
      .selectFrom('step_variants as sv')
      .innerJoin('steps as s', 's.id', 'sv.step_id')
      .select(['sv.id', 'sv.name'])
      .where('s.funnel_id', '=', funnelId)
      .execute(),
    sql<{ n: number }>`SELECT COUNT(DISTINCT v.visitor_id) AS n FROM page_views v WHERE v.funnel_id = ${funnelId} ${vSince}`.execute(db),
    sql<{ n: number }>`SELECT COUNT(*) AS n FROM contact_events e WHERE e.funnel_id = ${funnelId} AND e.type = 'optin' ${eSince}`.execute(db),
    sql<{ step_id: number; n: number }>`
      SELECT v.step_id, COUNT(*) AS n FROM page_views v WHERE v.funnel_id = ${funnelId} ${vSince} GROUP BY v.step_id`.execute(db),
    sql<{ step_id: number; n: number }>`
      SELECT e.step_id, COUNT(*) AS n FROM contact_events e
       WHERE e.funnel_id = ${funnelId} AND e.type = 'optin' AND e.step_id IS NOT NULL ${eSince} GROUP BY e.step_id`.execute(db),
    sql<{ key: string; n: number }>`
      SELECT ${viewKey(group)} AS key, COUNT(DISTINCT v.visitor_id) AS n FROM page_views v
       WHERE v.funnel_id = ${funnelId} ${vSince} ${vVariant} GROUP BY 1`.execute(db),
    sql<{ key: string; step_id: number; n: number }>`
      SELECT ${viewKey(group)} AS key, v.step_id, COUNT(*) AS n FROM page_views v
       WHERE v.funnel_id = ${funnelId} ${vSince} ${vVariant} GROUP BY 1, 2`.execute(db),
    sql<{ key: string; step_id: number | null; n: number }>`
      SELECT ${eventKey(group)} AS key, e.step_id, COUNT(*) AS n FROM contact_events e
       WHERE e.funnel_id = ${funnelId} AND e.type = 'optin' ${eSince} ${eVariant} GROUP BY 1, 2`.execute(db),
    sql<{ day: string; n: number }>`
      SELECT to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(DISTINCT v.visitor_id) AS n FROM page_views v
       WHERE v.funnel_id = ${funnelId} AND v.created_at >= ${dailySince}::date GROUP BY 1`.execute(db),
    sql<{ day: string; n: number }>`
      SELECT to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*) AS n FROM contact_events e
       WHERE e.funnel_id = ${funnelId} AND e.type = 'optin' AND e.created_at >= ${dailySince}::date GROUP BY 1`.execute(db),
  ]);

  const stepName = new Map(steps.map((s) => [s.id, s.name]));
  const variantName = new Map(variants.map((v) => [v.id, v.name]));
  const label = (key: string) => {
    if (group !== 'variant') return key;
    const [sid, vid] = key.split(':').map(Number);
    const vname = vid === 0 ? 'Original' : (variantName.get(vid!) ?? 'Variante supprimée');
    return `${stepName.get(sid!) ?? 'Étape supprimée'} — ${vname}`;
  };

  const rows = new Map<string, FunnelStatsRow>();
  const row = (key: string) => {
    let r = rows.get(key);
    if (!r) {
      r = { key, label: label(key), visitors: 0, optins: 0, rate: 0, steps: [] };
      rows.set(key, r);
    }
    return r;
  };
  const cell = (r: FunnelStatsRow, stepId: number) => {
    let c = r.steps.find((x) => x.step_id === stepId);
    if (!c) {
      c = { step_id: stepId, visitors: 0, optins: 0, rate: 0 };
      r.steps.push(c);
    }
    return c;
  };
  for (const x of rowsV.rows) row(x.key).visitors = Number(x.n);
  for (const x of rowsVSteps.rows) cell(row(x.key), x.step_id).visitors = Number(x.n);
  for (const x of rowsE.rows) {
    const r = row(x.key);
    r.optins += Number(x.n);
    if (x.step_id) cell(r, x.step_id).optins += Number(x.n);
  }
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const outRows = [...rows.values()]
    .map((r) => ({
      ...r,
      rate: rate(r.optins, r.visitors),
      steps: r.steps.map((c) => ({ ...c, rate: rate(c.optins, c.visitors) })).sort((a, b) => (order.get(a.step_id) ?? 999) - (order.get(b.step_id) ?? 999)),
    }))
    .sort((a, b) => b.visitors - a.visitors || b.optins - a.optins || a.label.localeCompare(b.label))
    .slice(0, 100);

  const daily: FunnelStats['daily'] = [];
  const dv = new Map(dailyV.rows.map((r) => [r.day, Number(r.n)]));
  const de = new Map(dailyE.rows.map((r) => [r.day, Number(r.n)]));
  for (let i = dailyDays - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    daily.push({ date, visitors: dv.get(date) ?? 0, optins: de.get(date) ?? 0 });
  }

  const visitors = Number(totalsV.rows[0]?.n ?? 0);
  const optins = Number(totalsE.rows[0]?.n ?? 0);
  return {
    period,
    group,
    since,
    totals: { visitors, optins, rate: rate(optins, visitors) },
    steps: steps.map((s) => {
      const v = Number(perStepV.rows.find((x) => x.step_id === s.id)?.n ?? 0);
      const o = Number(perStepE.rows.find((x) => x.step_id === s.id)?.n ?? 0);
      return { step_id: s.id, name: s.name, visitors: v, optins: o, rate: rate(o, v) };
    }),
    rows: outRows,
    daily,
  };
}

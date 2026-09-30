// Newsletter sending: recipients, start (immediate or scheduled), A/B subject test.
//
// - The recipient list is computed when the send starts (now, or at `scheduled_at` by the scheduler), never when the
//   newsletter is scheduled.
// - Starting is a conditional `draft|scheduled → sent` UPDATE in the same transaction as the insert of the sends:
//   two clicks, two scheduler instances or a click racing the scheduler can never queue a newsletter twice (the
//   loser finds no row), and a partial unique index (broadcast_id, contact_id) backs it.
// - A/B test: each variant goes to `test_percent` % of the recipients (random), then after `wait_hours` the winner
//   (best open rate, then click rate, then lowest index) is sent to everybody else — recomputed at that time.
//   Under AB_MIN_RECIPIENTS recipients the list is split evenly between the variants and there is no winner phase.
import { sql } from 'kysely';
import type { AbTestConfig, AbTestResult, AbVariantStats } from '@scalo/shared';
import { db, nowIso, type BroadcastRow, type Db } from '../db';
import { compileFilter, type ContactPredicate } from './segments';

export const AB_MIN_RECIPIENTS = 100;
const BATCH = 1000;

/** Subscribed, confirmed, deliverable contacts of an account, optionally restricted to a tag. */
export function recipients(userId: number, tagId: number | null, ex: Db = db, segment: ContactPredicate | null = null) {
  let q = ex
    .selectFrom('contacts as c')
    .where('c.user_id', '=', userId)
    .where('c.unsubscribed', '=', false)
    .where('c.bounced', '=', false)
    .where('c.confirmed_at', 'is not', null);
  if (tagId) {
    q = q.where((eb) =>
      eb.exists(eb.selectFrom('contact_tags as ct').select('ct.tag_id').whereRef('ct.contact_id', '=', 'c.id').where('ct.tag_id', '=', tagId)),
    );
  }
  if (segment) q = q.where((eb) => segment(eb));
  return q;
}

/** Predicate of the newsletter's segment (null when none), compiled when the send starts. */
export async function broadcastSegment(row: Pick<BroadcastRow, 'user_id' | 'segment_id'>, ex: Db = db): Promise<ContactPredicate | null> {
  if (!row.segment_id) return null;
  const seg = await ex.selectFrom('segments').select('filter').where('id', '=', row.segment_id).where('user_id', '=', row.user_id).executeTakeFirst();
  return seg ? compileFilter(row.user_id, seg.filter, ex) : null;
}

/** The A/B config when it is active (at least one alternative subject). */
export function activeAb(b: Pick<BroadcastRow, 'ab_test'>): AbTestConfig | null {
  const ab = b.ab_test;
  return ab && Array.isArray(ab.subjects) && ab.subjects.filter((s) => s.trim()).length > 0 ? ab : null;
}

/** Subject template of a variant (0 = the newsletter subject). */
export function variantSubject(b: Pick<BroadcastRow, 'subject' | 'ab_test'>, variant: number | null | undefined): string {
  if (!variant) return b.subject;
  return activeAb(b)?.subjects.filter((s) => s.trim())[variant - 1] ?? b.subject;
}

/** Queues the sends of a newsletter that has just been switched to 'sent' (inside the caller's transaction). */
export async function startBroadcast(trx: Db, row: BroadcastRow): Promise<void> {
  const now = nowIso();
  const ab = activeAb(row);
  const seg = await broadcastSegment(row, trx);
  if (!ab) {
    await trx
      .insertInto('email_sends')
      .columns(['user_id', 'contact_id', 'broadcast_id', 'kind', 'to_email', 'subject', 'status', 'send_at', 'created_at'])
      .expression(
        // parameters in a SELECT list need explicit types (they would default to text)
        recipients(row.user_id, row.tag_id, trx, seg).select([
          sql<number>`${row.user_id}::bigint`.as('user_id'),
          'c.id',
          sql<number>`${row.id}::bigint`.as('broadcast_id'),
          sql<string>`'broadcast'`.as('kind'),
          'c.email',
          sql<string>`${row.subject}::text`.as('subject'),
          sql<string>`'pending'`.as('status'),
          sql<string>`${now}::timestamptz`.as('send_at'),
          sql<string>`${now}::timestamptz`.as('created_at'),
        ]),
      )
      .execute();
    await trx.updateTable('broadcasts').set({ ab_phase: null, ab_winner: null, ab_decide_at: null }).where('id', '=', row.id).execute();
    return;
  }

  const list = await recipients(row.user_id, row.tag_id, trx, seg).select(['c.id', 'c.email']).orderBy(sql`random()`).execute();
  const n = ab.subjects.filter((s) => s.trim()).length + 1;
  let assigned: { id: number; email: string; variant: number }[];
  let phase: 'testing' | 'done';
  let decideAt: string | null = null;
  if (list.length < AB_MIN_RECIPIENTS) {
    assigned = list.map((c, i) => ({ ...c, variant: i % n }));
    phase = 'done';
  } else {
    const per = Math.max(1, Math.floor((list.length * ab.test_percent) / 100));
    assigned = list.slice(0, per * n).map((c, i) => ({ ...c, variant: Math.floor(i / per) }));
    phase = 'testing';
    decideAt = new Date(Date.now() + ab.wait_hours * 3600_000).toISOString();
  }
  for (let i = 0; i < assigned.length; i += BATCH) {
    await trx
      .insertInto('email_sends')
      .values(
        assigned.slice(i, i + BATCH).map((c) => ({
          user_id: row.user_id,
          contact_id: c.id,
          broadcast_id: row.id,
          kind: 'broadcast' as const,
          variant: c.variant,
          to_email: c.email,
          subject: variantSubject(row, c.variant),
          status: 'pending' as const,
          send_at: now,
          created_at: now,
        })),
      )
      .execute();
  }
  await trx.updateTable('broadcasts').set({ ab_phase: phase, ab_winner: null, ab_decide_at: decideAt }).where('id', '=', row.id).execute();
}

/** Starts the scheduled newsletters that are due. Safe with several instances. Returns how many were started. */
export async function runBroadcastScheduler(ex: Db = db): Promise<number> {
  const due = await ex
    .selectFrom('broadcasts')
    .select('id')
    .where('status', '=', 'scheduled')
    .where('scheduled_at', '<=', sql<string>`now()`)
    .orderBy('scheduled_at')
    .limit(20)
    .execute();
  let started = 0;
  for (const { id } of due) {
    const ok = await ex.transaction().execute(async (trx) => {
      const row = await trx
        .updateTable('broadcasts')
        .set({ status: 'sent', sent_at: nowIso() })
        .where('id', '=', id)
        .where('status', '=', 'scheduled')
        .where('scheduled_at', '<=', sql<string>`now()`)
        .returningAll()
        .executeTakeFirst();
      if (!row) return false; // another instance (or "send now") got there first
      await startBroadcast(trx, row);
      return true;
    });
    if (ok) started++;
  }
  return started;
}

interface VariantCounts { variant: number; sent: number; opened: number; clicked: number; pending: number; total: number; test: number }

async function variantCounts(b: Pick<BroadcastRow, 'id' | 'ab_decide_at'>, ex: Db): Promise<VariantCounts[]> {
  const cutoff = b.ab_decide_at ?? '9999-12-31T00:00:00Z';
  const { rows } = await sql<VariantCounts>`
    SELECT variant,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE opened_at IS NOT NULL OR clicked_at IS NOT NULL) AS opened,
      COUNT(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
      COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at < ${cutoff}::timestamptz) AS test
    FROM email_sends WHERE broadcast_id = ${b.id} AND NOT is_test AND variant IS NOT NULL
    GROUP BY variant ORDER BY variant`.execute(ex);
  return rows;
}

/** Best open rate, then best click rate, then the lowest variant index. */
export function pickWinner(stats: { variant: number; sent: number; opened: number; clicked: number }[], n: number): number {
  let best = 0;
  let bestKey = [-1, -1];
  for (let v = 0; v < n; v++) {
    const s = stats.find((x) => x.variant === v);
    const key = s && s.sent ? [s.opened / s.sent, s.clicked / s.sent] : [0, 0];
    if (key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) {
      best = v;
      bestKey = key;
    }
  }
  return best;
}

/** A/B tests whose waiting time is over: pick the winner and queue it for the remaining recipients. */
export async function decideAbTests(ex: Db = db): Promise<number> {
  const due = await ex
    .selectFrom('broadcasts')
    .select('id')
    .where('ab_phase', '=', 'testing')
    .where('ab_decide_at', '<=', sql<string>`now()`)
    .limit(20)
    .execute();
  let decided = 0;
  for (const { id } of due) {
    const ok = await ex.transaction().execute(async (trx) => {
      // decide time = created_at of the final sends: test sends are the ones created before it
      const now = nowIso();
      const row = await trx
        .updateTable('broadcasts')
        .set({ ab_phase: 'done', ab_decide_at: now })
        .where('id', '=', id)
        .where('ab_phase', '=', 'testing')
        .where('ab_decide_at', '<=', sql<string>`now()`)
        .returningAll()
        .executeTakeFirst();
      if (!row) return false;
      const n = (activeAb(row)?.subjects.filter((s) => s.trim()).length ?? 0) + 1;
      const winner = pickWinner(await variantCounts(row, trx), n);
      const seg = await broadcastSegment(row, trx);
      await trx
        .insertInto('email_sends')
        .columns(['user_id', 'contact_id', 'broadcast_id', 'kind', 'variant', 'to_email', 'subject', 'status', 'send_at', 'created_at'])
        .expression(
          recipients(row.user_id, row.tag_id, trx, seg)
            .where((eb) =>
              eb.not(eb.exists(eb.selectFrom('email_sends as es').select('es.id').whereRef('es.contact_id', '=', 'c.id').where('es.broadcast_id', '=', row.id))),
            )
            .select([
              sql<number>`${row.user_id}::bigint`.as('user_id'),
              'c.id',
              sql<number>`${row.id}::bigint`.as('broadcast_id'),
              sql<string>`'broadcast'`.as('kind'),
              sql<number>`${winner}::smallint`.as('variant'),
              'c.email',
              sql<string>`${variantSubject(row, winner)}::text`.as('subject'),
              sql<string>`'pending'`.as('status'),
              sql<string>`${now}::timestamptz`.as('send_at'),
              sql<string>`${now}::timestamptz`.as('created_at'),
            ]),
        )
        .onConflict((oc) => oc.doNothing())
        .execute();
      await trx.updateTable('broadcasts').set({ ab_winner: winner }).where('id', '=', row.id).execute();
      return true;
    });
    if (ok) decided++;
  }
  return decided;
}

/** A/B progress + per-variant stats of a newsletter (null when no test). */
export async function abResult(b: BroadcastRow, ex: Db = db): Promise<AbTestResult | null> {
  const ab = activeAb(b);
  if (!ab || b.status !== 'sent') return null;
  const subjects = [b.subject, ...ab.subjects.filter((s) => s.trim())];
  const counts = await variantCounts(b, ex);
  const splitOnly = b.ab_phase === 'done' && b.ab_decide_at === null;
  const variants: AbVariantStats[] = subjects.map((subject, index) => {
    const c = counts.find((x) => x.variant === index);
    const sent = c?.sent ?? 0;
    return {
      index,
      subject,
      sent,
      opened: c?.opened ?? 0,
      clicked: c?.clicked ?? 0,
      pending: c?.pending ?? 0,
      test_recipients: splitOnly ? (c?.total ?? 0) : (c?.test ?? 0),
      open_rate: sent ? (c!.opened / sent) : 0,
      click_rate: sent ? (c!.clicked / sent) : 0,
    };
  });
  return { phase: b.ab_phase, winner: b.ab_winner, decide_at: b.ab_decide_at, split_only: splitOnly, variants };
}

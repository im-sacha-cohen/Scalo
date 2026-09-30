import { Router } from 'express';
import { sql } from 'kysely';
import type { DashboardStats } from '@scalo/shared';
import { db } from '../db';
import { uid } from '../util';

export const dashboardRouter = Router();

dashboardRouter.get('/dashboard', async (req, res) => {
  const userId = uid(req);

  // 30 UTC days ending today (inclusive), zero-filled by generate_series.
  const dailyQ = sql<{ date: string; views: number; optins: number; contacts: number }>`
    WITH days AS (
      SELECT d::date AS day
        FROM generate_series((now() AT TIME ZONE 'UTC')::date - 29, (now() AT TIME ZONE 'UTC')::date, interval '1 day') AS d
    ),
    since AS (SELECT ((now() AT TIME ZONE 'UTC')::date - 29)::timestamp AT TIME ZONE 'UTC' AS t),
    v AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n FROM page_views
           WHERE user_id = ${userId} AND created_at >= (SELECT t FROM since) GROUP BY 1),
    o AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n FROM contact_events
           WHERE user_id = ${userId} AND type = 'optin' AND created_at >= (SELECT t FROM since) GROUP BY 1),
    c AS (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS n FROM contacts
           WHERE user_id = ${userId} AND created_at >= (SELECT t FROM since) GROUP BY 1)
    SELECT to_char(days.day, 'YYYY-MM-DD') AS date,
           COALESCE(v.n, 0) AS views, COALESCE(o.n, 0) AS optins, COALESCE(c.n, 0) AS contacts
      FROM days
      LEFT JOIN v ON v.day = days.day
      LEFT JOIN o ON o.day = days.day
      LEFT JOIN c ON c.day = days.day
     ORDER BY days.day`;

  const totalsQ = sql<{
    contacts: number; new_contacts_7d: number; funnels: number; views_30d: number; optins_30d: number; sent30: number; opened30: number;
  }>`
    SELECT
      (SELECT COUNT(*) FROM contacts WHERE user_id = ${userId}) AS contacts,
      (SELECT COUNT(*) FROM contacts WHERE user_id = ${userId} AND created_at >= now() - interval '7 days') AS new_contacts_7d,
      (SELECT COUNT(*) FROM funnels WHERE user_id = ${userId}) AS funnels,
      (SELECT COUNT(*) FROM page_views WHERE user_id = ${userId} AND created_at >= now() - interval '30 days') AS views_30d,
      (SELECT COUNT(*) FROM contact_events WHERE user_id = ${userId} AND type = 'optin' AND created_at >= now() - interval '30 days') AS optins_30d,
      s.sent30, s.opened30
    FROM (
      SELECT COUNT(*) AS sent30, COUNT(*) FILTER (WHERE opened_at IS NOT NULL) AS opened30
        FROM email_sends
       WHERE user_id = ${userId} AND NOT is_test AND kind <> 'confirmation' AND status = 'sent' AND sent_at >= now() - interval '30 days'
    ) s`;

  const [daily, totals] = await Promise.all([dailyQ.execute(db), totalsQ.execute(db)]);
  const t = totals.rows[0];
  const stats: DashboardStats = {
    contacts: t.contacts,
    new_contacts_7d: t.new_contacts_7d,
    funnels: t.funnels,
    views_30d: t.views_30d,
    optins_30d: t.optins_30d,
    emails_sent_30d: t.sent30,
    open_rate: t.sent30 ? Math.round((t.opened30 / t.sent30) * 1000) / 1000 : 0,
    daily: daily.rows,
  };
  res.json(stats);
});

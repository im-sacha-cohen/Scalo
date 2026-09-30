/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// Audit log: who did what (actor, action, resource, IP, date) on the API mutations of an account.
// Recorded from the hook called by requireAuth for every authenticated request; consultable, exportable (CSV),
// retention configurable per account.
import type { Request, Response } from 'express';
import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../../api/src/db';
import { apiPath } from '../../../api/src/access';
import { likeEscape, uid } from '../../../api/src/util';
import type { AuditLogEntry } from '../../shared/types';
import { actorOf, requireAdmin, requireFeature, roleOf } from './common';
import { license } from './license/service';

export const DEFAULT_RETENTION_DAYS = 365;
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const VERBS: Record<string, string> = { POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' };

/** `POST /contacts` → contacts.create · `PATCH /contacts/12` → contacts.update · `POST /broadcasts/5/send` → broadcasts.send */
export function describeAction(method: string, path: string): { action: string; resourceType: string; resourceId: string | null } {
  const segs = path.split('/').filter(Boolean);
  const isId = (s: string) => /^\d+$/.test(s);
  const names = segs.filter((s) => !isId(s)).map((s) => s.slice(0, 40));
  const last = segs[segs.length - 1] ?? '';
  const base = names.join('.') || 'api';
  const subAction = method === 'POST' && names.length > 1 && !isId(last);
  return {
    action: (subAction ? base : `${base}.${VERBS[method] ?? method.toLowerCase()}`).slice(0, 120),
    resourceType: names[0] ?? '',
    resourceId: segs.find(isId) ?? null,
  };
}

export interface AuditEvent {
  accountId: number;
  actorId: number | null;
  role: string;
  action: string;
  method: string;
  path: string;
  resourceType?: string;
  resourceId?: string | null;
  status: number;
  ip: string;
}

const pending = new Set<Promise<unknown>>();

/** Writes an entry (never throws: the audit trail must not break the request it describes). */
export function recordAudit(e: AuditEvent): Promise<void> {
  const p = db
    .insertInto('audit_logs')
    .values({
      account_id: e.accountId,
      actor_id: e.actorId,
      actor_email: e.actorId ? sql<string>`coalesce((select email from users where id = ${e.actorId}), '')` : '',
      actor_role: e.role,
      action: e.action,
      method: e.method,
      path: e.path.slice(0, 500),
      resource_type: e.resourceType ?? '',
      resource_id: e.resourceId ?? null,
      status: e.status,
      ip: e.ip.slice(0, 64),
      created_at: new Date().toISOString(),
    })
    .execute()
    .then(() => undefined)
    .catch((err) => {
      // 23503: the account was deleted by the very request being logged
      if ((err as { code?: string })?.code !== '23503') console.error('[audit]', (err as Error).message);
    });
  pending.add(p);
  void p.finally(() => pending.delete(p));
  return p;
}

/** Resolves once every entry being written is stored (tests, graceful shutdown). */
export const auditIdle = () => Promise.all([...pending]).then(() => undefined);

/** Hook called by requireAuth: logs successful mutations and refused ones (403). Reads are not logged. */
export function auditRequest(req: Request, res: Response) {
  if (SAFE.has(req.method) || !license.has('audit_log')) return;
  res.on('finish', () => {
    if (!req.userId) return;
    if (res.statusCode >= 400 && res.statusCode !== 403) return; // validation errors, not found…: nothing happened
    const path = apiPath(req.originalUrl);
    const d = describeAction(req.method, path);
    void recordAudit({
      accountId: req.userId,
      actorId: actorOf(req),
      role: roleOf(req),
      action: d.action,
      method: req.method,
      path,
      resourceType: d.resourceType,
      resourceId: d.resourceId,
      status: res.statusCode,
      ip: req.ip ?? req.socket.remoteAddress ?? '',
    });
  });
}

export async function retentionDays(accountId: number): Promise<number> {
  const row = await db.selectFrom('account_ee_settings').select('audit_retention_days').where('account_id', '=', accountId).executeTakeFirst();
  return row?.audit_retention_days ?? DEFAULT_RETENTION_DAYS;
}

/** Deletes entries older than the retention of their account. Returns the number of entries removed. */
export async function purgeAuditLogs(accountId?: number): Promise<number> {
  const res = await sql`
    DELETE FROM audit_logs a
    WHERE a.created_at < now() - make_interval(days => COALESCE(
      (SELECT s.audit_retention_days FROM account_ee_settings s WHERE s.account_id = a.account_id), ${DEFAULT_RETENTION_DAYS}))
    ${accountId ? sql`AND a.account_id = ${accountId}` : sql``}`.execute(db);
  return Number(res.numAffectedRows ?? 0);
}

// ---------- routes ----------

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(200).optional(),
  actor_id: z.coerce.number().int().positive().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

function filtered(accountId: number, q: z.infer<typeof listSchema>) {
  let qb = db.selectFrom('audit_logs').where('account_id', '=', accountId);
  if (q.actor_id) qb = qb.where('actor_id', '=', q.actor_id);
  if (q.from) qb = qb.where('created_at', '>=', q.from);
  if (q.to) qb = qb.where('created_at', '<=', q.to);
  if (q.search) {
    const like = `%${likeEscape(q.search)}%`;
    qb = qb.where((eb) => eb.or([eb('action', 'ilike', like), eb('path', 'ilike', like), eb('actor_email', 'ilike', like), eb('ip', 'ilike', like)]));
  }
  return qb;
}

const COLUMNS = ['id', 'actor_id', 'actor_email', 'actor_role', 'action', 'method', 'path', 'resource_type', 'resource_id', 'status', 'ip', 'created_at'] as const;

/** Spreadsheet-safe CSV cell. */
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const auditRouter = Router();

auditRouter.get('/audit', async (req, res) => {
  requireAdmin(req);
  requireFeature('audit_log');
  const q = listSchema.parse(req.query);
  const accountId = uid(req);
  const [items, count] = await Promise.all([
    filtered(accountId, q).select(COLUMNS).orderBy('id', 'desc').limit(q.limit).offset((q.page - 1) * q.limit).execute(),
    filtered(accountId, q).select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
  ]);
  res.json({ items: items satisfies AuditLogEntry[], total: count.n, retention_days: await retentionDays(accountId) });
});

// The export stays available once the license has lapsed: the entries already recorded are the account's data.
auditRouter.get('/audit/export', async (req, res) => {
  requireAdmin(req);
  const accountId = uid(req);
  const q = listSchema.parse({ ...req.query, page: 1, limit: 1 });
  if (!license.has('audit_log')) {
    const any = await db.selectFrom('audit_logs').select('id').where('account_id', '=', accountId).limit(1).executeTakeFirst();
    if (!any) requireFeature('audit_log');
  }
  const rows = await filtered(accountId, q).select(COLUMNS).orderBy('id', 'desc').limit(100_000).execute();
  const header = ['date', 'acteur', 'role', 'action', 'methode', 'chemin', 'ressource', 'id_ressource', 'statut', 'ip'];
  const lines = rows.map((r) => [r.created_at, r.actor_email, r.actor_role, r.action, r.method, r.path, r.resource_type, r.resource_id, r.status, r.ip].map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="journal-audit.csv"');
  res.send(`﻿${[header.join(','), ...lines].join('\n')}\n`);
});

auditRouter.put('/audit/settings', async (req, res) => {
  requireAdmin(req);
  requireFeature('audit_log');
  const body = z.object({ retention_days: z.number().int().min(1).max(3650) }).parse(req.body);
  const accountId = uid(req);
  const now = new Date().toISOString();
  await db
    .insertInto('account_ee_settings')
    .values({ account_id: accountId, audit_retention_days: body.retention_days, updated_at: now })
    .onConflict((oc) => oc.column('account_id').doUpdateSet({ audit_retention_days: body.retention_days, updated_at: now }))
    .execute();
  const purged = await purgeAuditLogs(accountId);
  res.json({ retention_days: body.retention_days, purged });
});

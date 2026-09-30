/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
// White label: remove / replace the « Propulsé par Scalo » mention of public pages and emails, custom name and logo
// in the admin interface. The values are stored per account and only applied while the license has `white_label`.
import { Router } from 'express';
import { z } from 'zod';
import type { EditionBranding } from '@scalo/shared';
import { db } from '../../../api/src/db';
import type { PoweredBy } from '../../../api/src/ee';
import { uid } from '../../../api/src/util';
import type { Branding } from '../../shared/types';
import { requireAdmin, requireFeature } from './common';
import { license } from './license/service';

type Row = Omit<Branding, 'active'>;
const EMPTY: Row = { hide_powered_by: false, powered_by_text: '', powered_by_url: '', app_name: '', logo_url: '' };

// In memory so the email footer (synchronous) can read it; reloaded on write and every minute (other instances).
const cache = new Map<number, Row>();

export async function refreshBranding() {
  const rows = await db
    .selectFrom('account_ee_settings')
    .select(['account_id', 'hide_powered_by', 'powered_by_text', 'powered_by_url', 'app_name', 'logo_url'])
    .where((eb) => eb.or([eb('hide_powered_by', '=', true), eb('powered_by_text', '<>', ''), eb('app_name', '<>', ''), eb('logo_url', '<>', '')]))
    .execute();
  cache.clear();
  for (const { account_id, ...row } of rows) cache.set(account_id, row);
}

/** Mention of public pages and emails. null: the default « Propulsé par Scalo ». */
export function poweredBy(accountId: number): PoweredBy | null {
  if (!license.has('white_label')) return null;
  const row = cache.get(accountId);
  if (!row || (!row.hide_powered_by && !row.powered_by_text)) return null;
  return { hidden: row.hide_powered_by, text: row.hide_powered_by ? undefined : row.powered_by_text, url: row.powered_by_url };
}

/** Name / logo of the admin interface. null: Scalo. */
export function adminBranding(accountId: number): EditionBranding | null {
  if (!license.has('white_label')) return null;
  const row = cache.get(accountId);
  return row && (row.app_name || row.logo_url) ? { app_name: row.app_name, logo_url: row.logo_url } : null;
}

const schema = z.object({
  hide_powered_by: z.boolean(),
  powered_by_text: z.string().trim().max(80),
  powered_by_url: z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(500)]),
  app_name: z.string().trim().max(40),
  logo_url: z.union([z.literal(''), z.string().trim().max(500).regex(/^(https:\/\/|\/uploads\/)/, 'doit être une URL https:// ou une image de la médiathèque')]),
});

export const brandingRouter = Router();

brandingRouter.get('/branding', async (req, res) => {
  const row = await db
    .selectFrom('account_ee_settings')
    .select(['hide_powered_by', 'powered_by_text', 'powered_by_url', 'app_name', 'logo_url'])
    .where('account_id', '=', uid(req))
    .executeTakeFirst();
  res.json({ ...(row ?? EMPTY), active: license.has('white_label') } satisfies Branding);
});

brandingRouter.put('/branding', async (req, res) => {
  requireAdmin(req);
  requireFeature('white_label');
  const body = schema.parse(req.body);
  const accountId = uid(req);
  const now = new Date().toISOString();
  await db
    .insertInto('account_ee_settings')
    .values({ account_id: accountId, ...body, updated_at: now })
    .onConflict((oc) => oc.column('account_id').doUpdateSet({ ...body, updated_at: now }))
    .execute();
  cache.set(accountId, body);
  res.json({ ...body, active: true } satisfies Branding);
});

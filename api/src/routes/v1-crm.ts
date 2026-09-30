// Public API v1 — CRM endpoints: custom fields, segments (read), purchases. Mounted by routes/v1.ts (same auth, rate
// limit and scope checks).
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import type { OAuthScope } from '@scalo/shared';
import { db } from '../db';
import { recordPurchase } from '../services/contact-actions';
import { getContact, getContactRow, normEmail, upsertContact } from '../services/contacts';
import { listFieldDefs } from '../services/fields';
import { HttpError, notFound, paramId } from '../util';
import { listContacts, listSchema } from './contacts';
import { createField, createFieldSchema, segmentRows, toSegments } from './crm';

interface V1Helpers {
  need: (scope: OAuthScope) => (req: Request, res: Response, next: NextFunction) => void;
  grant: (req: Request) => { userId: number; scopes: OAuthScope[] };
}

const purchaseSchema = z
  .object({
    contact_id: z.number().int().positive().optional(),
    email: z.email().max(254).optional(),
    first_name: z.string().trim().max(200).optional(),
    last_name: z.string().trim().max(200).optional(),
    product: z.string().trim().min(1).max(200),
    amount: z.number().min(0).max(1e9).nullable().optional(),
    currency: z.string().trim().regex(/^[A-Za-z]{3}$/, 'Code devise ISO à 3 lettres (EUR, USD…)').nullable().optional(),
    external_id: z.string().trim().max(200).nullable().optional(),
  })
  .refine((p) => !!p.contact_id !== !!p.email, { message: 'Indiquez soit contact_id, soit email', path: ['email'] });

export function mountV1Crm(r: Router, { need, grant }: V1Helpers) {
  r.get('/custom-fields', need('contacts:read'), async (req, res) => {
    res.json(await listFieldDefs(grant(req).userId));
  });

  r.post('/custom-fields', need('contacts:write'), async (req, res) => {
    res.status(201).json(await createField(grant(req).userId, createFieldSchema.parse(req.body)));
  });

  r.get('/segments', need('contacts:read'), async (req, res) => {
    const { userId } = grant(req);
    res.json(await toSegments(userId, await segmentRows(userId).execute()));
  });

  r.get('/segments/:id', need('contacts:read'), async (req, res) => {
    const { userId } = grant(req);
    const s = await segmentRows(userId).where('id', '=', paramId(req.params.id, 'Segment')).executeTakeFirst();
    if (!s) throw notFound('Segment');
    res.json((await toSegments(userId, [s]))[0]);
  });

  /** Contacts of a segment (same pagination as GET /contacts). */
  r.get('/segments/:id/contacts', need('contacts:read'), async (req, res) => {
    const { userId } = grant(req);
    const segmentId = paramId(req.params.id, 'Segment');
    if (!(await segmentRows(userId).where('id', '=', segmentId).executeTakeFirst())) throw notFound('Segment');
    const q = listSchema.extend({ limit: z.coerce.number().int().min(1).max(100).optional().default(50) }).parse({ ...req.query, segment_id: segmentId });
    res.json({ ...(await listContacts(userId, q)), page: q.page, limit: q.limit });
  });

  /**
   * Records a purchase (no payment in the app): by contact_id, or by email (contact created if needed, confirmed like
   * any contact created through the API). Fires the "Achat" automations. Idempotent on external_id.
   */
  r.post('/purchases', need('purchases:write'), async (req, res) => {
    const g = grant(req);
    const p = purchaseSchema.parse(req.body);
    const out = await db.transaction().execute(async (trx) => {
      let contactId: number;
      if (p.contact_id) {
        const c = await getContactRow(g.userId, p.contact_id, trx);
        if (!c) throw notFound('Contact');
        contactId = c.id;
      } else {
        if (!g.scopes.includes('contacts:write') && !(await trx.selectFrom('contacts').select('id').where('user_id', '=', g.userId).where('email', '=', normEmail(p.email!)).executeTakeFirst())) {
          throw new HttpError(403, 'Contact inconnu : le scope « contacts:write » est requis pour le créer');
        }
        contactId = (await upsertContact(g.userId, { email: p.email!, first_name: p.first_name, last_name: p.last_name }, {}, trx)).contact.id;
      }
      const purchase = await recordPurchase(g.userId, contactId, { product: p.product, amount: p.amount, currency: p.currency, external_id: p.external_id }, 'api', trx);
      return { purchase, contact: (await getContact(g.userId, contactId, trx))! };
    });
    const { created, ...purchase } = out.purchase;
    res.status(created ? 201 : 200).json({ purchase, contact: out.contact });
  });
}

import { Router } from 'express';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Tag } from '@scalo/shared';
import { db } from '../db';
import { findTag, getOrCreateTag } from '../services/contacts';
import { HttpError, notFound, paramId, uid } from '../util';

export const tagsRouter = Router();

tagsRouter.get('/tags', async (req, res) => {
  const rows: Tag[] = await db
    .selectFrom('tags as t')
    .select((eb) => [
      't.id',
      't.name',
      eb.selectFrom('contact_tags as ct').select(eb.fn.countAll<number>().as('n')).whereRef('ct.tag_id', '=', 't.id').as('contacts_count'),
    ])
    .where('t.user_id', '=', uid(req))
    .orderBy(sql`lower(t.name)`)
    .execute()
    .then((rs) => rs.map((r) => ({ ...r, contacts_count: Number(r.contacts_count ?? 0) })));
  res.json(rows);
});

tagsRouter.post('/tags', async (req, res) => {
  const userId = uid(req);
  const { name } = z.object({ name: z.string().trim().min(1).max(60) }).parse(req.body);
  if (await findTag(userId, name)) throw new HttpError(409, 'Ce tag existe déjà');
  res.status(201).json({ ...(await getOrCreateTag(userId, name)), contacts_count: 0 });
});

tagsRouter.delete('/tags/:id', async (req, res) => {
  const userId = uid(req);
  const id = paramId(req.params.id, 'Tag');
  const r = await db.deleteFrom('tags').where('id', '=', id).where('user_id', '=', userId).executeTakeFirst();
  if (!Number(r.numDeletedRows)) throw notFound('Tag');
  res.json({ ok: true });
});

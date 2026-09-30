// Public API v1 — sales (read only): products with their offers, orders. Scope `sales:read`. Mounted by routes/v1.ts
// (same auth, rate limit and scope checks). Stripe identifiers and keys are never exposed.
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import type { OAuthScope } from '@scalo/shared';
import { notFound, paramId } from '../util';
import { listOrders, listProducts, orderDetail, orderListSchema } from './payments';

interface V1Helpers {
  need: (scope: OAuthScope) => (req: Request, res: Response, next: NextFunction) => void;
  grant: (req: Request) => { userId: number; scopes: OAuthScope[] };
}

export function mountV1Sales(r: Router, { need, grant }: V1Helpers) {
  r.get('/products', need('sales:read'), async (req, res) => {
    res.json(await listProducts(grant(req).userId));
  });

  r.get('/orders', need('sales:read'), async (req, res) => {
    const q = orderListSchema.extend({ limit: z.coerce.number().int().min(1).max(100).optional().default(50) }).parse(req.query);
    res.json({ ...(await listOrders(grant(req).userId, q)), page: q.page, limit: q.limit });
  });

  r.get('/orders/:id', need('sales:read'), async (req, res) => {
    const o = await orderDetail(grant(req).userId, paramId(req.params.id, 'Commande'));
    if (!o) throw notFound('Commande');
    res.json(o);
  });
}

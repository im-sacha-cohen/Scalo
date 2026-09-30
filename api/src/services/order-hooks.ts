// Extension point of the payments module: other features (affiliation, invoicing, analytics…) register a hook that
// runs when an order changes state. Documented in SPEC.md (« Paiements → Point d'extension »).
//
// A hook runs INSIDE the database transaction that changes the order: what it writes is committed together with the
// order (exactly once per event — the transitions themselves are idempotent), and it reads the order as it will be
// committed. Each hook runs in its own SAVEPOINT: a hook that throws is rolled back and logged, it never blocks the
// payment nor the other hooks. Hooks must not call external services (they hold the order's row lock): queue work
// in a table and do it later.
import { sql, type Selectable } from 'kysely';
import type { Db, OrderItemsTable, OrdersTable } from '../db';

export type OrderRow = Selectable<OrdersTable>;
export type OrderItemRow = Selectable<OrderItemsTable>;

/**
 * - `paid`: the order just became paid (first payment of a subscription included). `amount` = amount collected.
 * - `subscription_payment`: a later invoice of a subscription / installment plan was paid. `amount` = that invoice.
 * - `refunded`: money was given back. `amount` = what this refund adds (minor units); `full` = nothing is left.
 * - `subscription_canceled`: the subscription ended (cancelled, unpaid) — not fired when installments are all paid.
 */
export type OrderHookEvent = 'paid' | 'subscription_payment' | 'refunded' | 'subscription_canceled';

export interface OrderHookContext {
  event: OrderHookEvent;
  /** The order after the change (status, amount_paid, amount_refunded, contact_id… up to date). */
  order: OrderRow;
  items: OrderItemRow[];
  /** Minor units of `order.currency` (0 for `subscription_canceled`). */
  amount: number;
  /** `refunded` only: the order is now fully refunded. */
  full?: boolean;
}

export type OrderHook = (ctx: OrderHookContext, trx: Db) => Promise<void> | void;

const hooks = new Map<string, OrderHook>();

/** Registers (or replaces) the hook `name`. Returns a function that removes it. */
export function registerOrderHook(name: string, hook: OrderHook): () => void {
  hooks.set(name, hook);
  return () => {
    if (hooks.get(name) === hook) hooks.delete(name);
  };
}

/** Shorthands: `onOrderPaid('affiliates', async (order, trx, ctx) => …)`. */
export const onOrderPaid = (name: string, fn: (order: OrderRow, trx: Db, ctx: OrderHookContext) => Promise<void> | void) =>
  registerOrderHook(`${name}:paid`, (ctx, trx) => (ctx.event === 'paid' ? fn(ctx.order, trx, ctx) : undefined));
export const onOrderRefunded = (name: string, fn: (order: OrderRow, trx: Db, ctx: OrderHookContext) => Promise<void> | void) =>
  registerOrderHook(`${name}:refunded`, (ctx, trx) => (ctx.event === 'refunded' ? fn(ctx.order, trx, ctx) : undefined));

/** Called by services/payments.ts inside the order's transaction. */
export async function runOrderHooks(ctx: OrderHookContext, trx: Db): Promise<void> {
  let i = 0;
  for (const [name, hook] of hooks) {
    const sp = sql.raw(`order_hook_${i++}`);
    await sql`SAVEPOINT ${sp}`.execute(trx);
    try {
      await hook(ctx, trx);
      await sql`RELEASE SAVEPOINT ${sp}`.execute(trx);
    } catch (e) {
      await sql`ROLLBACK TO SAVEPOINT ${sp}`.execute(trx);
      console.error(`[orders] hook « ${name} » (${ctx.event}, commande ${ctx.order.id}) :`, (e as Error).message);
    }
  }
}

/** Cookies copied to `orders.visitor.cookies` at checkout (affiliate / referral tracking set by extensions). */
export const VISITOR_COOKIE_RE = /^scalo_(aff|ref)[a-z0-9_]{0,40}$/;

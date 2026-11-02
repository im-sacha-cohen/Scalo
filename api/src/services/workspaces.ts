// Workspaces: the accounts of a person (see migration 0017 and workspace-access.ts).
//
// The first account of a person has his id and is created at sign-up; the deletion of that one deletes the person
// and all his workspaces (Paramètres → Données et compte). The other workspaces are created here and deleted one by
// one, with all their data, through the same screen.
import { sql } from 'kysely';
import type { AccountRole, Workspace } from '@scalo/shared';
import { roleAllows } from '../access';
import { db, type Db } from '../db';
import { HttpError, notFound } from '../util';
import { resolveWorkspace } from '../workspace-access';

/** Workspaces a person may own. */
export const MAX_WORKSPACES = 50;

/** Name + contact address of an account (the email of its owner). Replaces `users` wherever the account is meant. */
export async function accountInfo(accountId: number, ex: Db = db) {
  return ex
    .selectFrom('accounts as a')
    .innerJoin('users as u', 'u.id', 'a.owner_id')
    .select(['a.id', 'a.name', 'u.email', 'a.created_at', 'a.owner_id'])
    .where('a.id', '=', accountId)
    .executeTakeFirst();
}

export async function accountInfoOrThrow(accountId: number, ex: Db = db) {
  const a = await accountInfo(accountId, ex);
  if (!a) throw new Error(`Compte ${accountId} introuvable`);
  return a;
}

/** The account of a new person (same id), in the transaction that creates him. */
export async function createPersonalAccount(ex: Db, user: { id: number; name: string }) {
  await ex.insertInto('accounts').values({ id: user.id, owner_id: user.id, name: user.name.trim() || 'Mon espace' }).execute();
}

const toWorkspace = (a: { id: number; name: string; owner_id: number; created_at: string }, role: AccountRole): Workspace => ({
  id: a.id,
  name: a.name,
  role,
  personal: a.id === a.owner_id,
  created_at: a.created_at,
});

/** The workspaces the person can switch to: the ones he owns, then the account he works on as a team member. */
export async function listWorkspaces(personId: number, current: { accountId: number; role: AccountRole }): Promise<Workspace[]> {
  const owned = await db.selectFrom('accounts').select(['id', 'name', 'owner_id', 'created_at']).where('owner_id', '=', personId).orderBy('created_at').orderBy('id').execute();
  const list = owned.map((a) => toWorkspace(a, 'owner'));
  if (!owned.some((a) => a.id === current.accountId)) {
    const a = await db.selectFrom('accounts').select(['id', 'name', 'owner_id', 'created_at']).where('id', '=', current.accountId).executeTakeFirst();
    if (a) list.push(toWorkspace(a, current.role));
  }
  return list;
}

/** Access of a person to an account, for the screens that pick a workspace themselves (OAuth consent). */
export async function workspaceAccess(personId: number, accountId: number) {
  const access = await resolveWorkspace(personId, accountId);
  return access && access !== 'no-person' ? access : null;
}

// ---------- OAuth grants (consent screen, public API, MCP) ----------

/** Roles that may connect an application to a workspace: owners and administrators. */
export const canGrant = (role: AccountRole) => roleAllows(role, 'POST', '/oauth/consent');

/** Workspaces a person may connect an application to (`current`: where he works, kept if he is not its owner). */
export async function grantableWorkspaces(personId: number, current: { accountId: number; role: AccountRole }) {
  return (await listWorkspaces(personId, current)).filter((w) => canGrant(w.role));
}

/**
 * Workspace a token works on. A token bound to one workspace (`person_id` null) only works on it. A token of every
 * workspace (`person_id` set) works on the requested one if that person may still authorize it, by default on the one
 * it was granted from. null: refused.
 */
export async function tokenWorkspace(t: { user_id: number; person_id: number | null }, wanted?: number): Promise<number | null> {
  const target = wanted ?? t.user_id;
  if (t.person_id === null) return target === t.user_id ? target : null;
  const access = await workspaceAccess(t.person_id, target);
  return access && canGrant(access.role) ? target : null;
}

/** Every workspace a token of every workspace reaches right now (id order of the person's list). */
export async function tokenWorkspaces(t: { user_id: number; person_id: number }) {
  const home = await workspaceAccess(t.person_id, t.user_id);
  return grantableWorkspaces(t.person_id, home ?? { accountId: t.person_id, role: 'owner' });
}

/** Only people who own their own account create workspaces (not the logins of team members). */
export async function createWorkspace(personId: number, name: string): Promise<Workspace> {
  return db.transaction().execute(async (trx) => {
    // serializes concurrent creations of the same person (limit below)
    const own = await trx.selectFrom('accounts').select('id').where('id', '=', personId).where('owner_id', '=', personId).forUpdate().executeTakeFirst();
    if (!own) throw new HttpError(403, 'Seul le propriétaire d’un compte peut créer des espaces de travail');
    const { n } = await trx.selectFrom('accounts').select((eb) => eb.fn.countAll<number>().as('n')).where('owner_id', '=', personId).executeTakeFirstOrThrow();
    if (n >= MAX_WORKSPACES) throw new HttpError(409, `Limite de ${MAX_WORKSPACES} espaces de travail atteinte`);
    // ids come from the users sequence: an account id is never the id of another person (see migration 0017)
    const a = await trx
      .insertInto('accounts')
      .values({ id: sql<number>`nextval(pg_get_serial_sequence('users', 'id'))`, owner_id: personId, name })
      .returning(['id', 'name', 'owner_id', 'created_at'])
      .executeTakeFirstOrThrow();
    return toWorkspace(a, 'owner');
  });
}

export async function renameWorkspace(personId: number, accountId: number, name: string): Promise<Workspace> {
  const a = await db
    .updateTable('accounts')
    .set({ name })
    .where('id', '=', accountId)
    .where('owner_id', '=', personId)
    .returning(['id', 'name', 'owner_id', 'created_at'])
    .executeTakeFirst();
  if (!a) throw notFound('Espace de travail');
  return toWorkspace(a, 'owner');
}

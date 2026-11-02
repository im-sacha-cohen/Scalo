// Which account (workspace) a signed-in person works on, and with which role.
//
// A person owns one or several accounts (`accounts.owner_id`, see migration 0017): his own one (same id as the person)
// and the workspaces he created. The Enterprise edition adds the accounts he belongs to as a team member.
// Used by requireAuth (util.ts) for every session request, and by the OAuth consent screen.
//
// Nothing here imports util.ts (no cycle): only the database and the extension registry.
import type { AccountRole } from '@scalo/shared';
import { db } from './db';
import { loadEe } from './ee';

/** Header of the web app: the workspace the request works on. Absent: the person's own account. */
export const WORKSPACE_HEADER = 'x-scalo-workspace';

export type WorkspaceAccess = { accountId: number; role: AccountRole };

/**
 * `wanted` = account requested (undefined: the person's own account, or his team account in the Enterprise edition).
 * Returns 'no-person' if the person no longer exists, null if he has no access to the requested account.
 * May throw an HttpError of the extension (member without a valid license).
 */
export async function resolveWorkspace(personId: number, wanted?: number): Promise<WorkspaceAccess | 'no-person' | null> {
  const row = await db
    .selectFrom('users as u')
    .leftJoin('accounts as a', (j) => j.onRef('a.owner_id', '=', 'u.id').on('a.id', '=', wanted ?? personId))
    .select(['u.id', 'a.id as account_id'])
    .where('u.id', '=', personId)
    .executeTakeFirst();
  if (!row) return 'no-person';
  if (row.account_id !== null) return { accountId: row.account_id, role: 'owner' };
  const ext = await loadEe();
  return (await ext?.resolveActor(personId, wanted)) ?? null;
}

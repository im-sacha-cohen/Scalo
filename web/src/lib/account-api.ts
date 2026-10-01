// Paramètres → Données et compte: summary, GDPR export, deletion of the data, deletion of the account (owner only).
import type { AccountDataSummary, AccountDeletionInput } from '@scalo/shared';
import { rawRequest, request } from './api';

type Deleted = { ok: true; deleted: AccountDataSummary['counts'] };

export const accountApi = {
  summary: () => request<AccountDataSummary>('GET', '/account/summary'),
  /** ZIP archive (contacts, funnels, emails, sales, courses…, settings without any secret). */
  exportZip: async () => {
    const res = await rawRequest('POST', '/account/export');
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'scalo-export.zip';
    return { blob: await res.blob(), name };
  },
  resetData: (b: AccountDeletionInput) => request<Deleted>('POST', '/account/reset', b),
  deleteAccount: (b: AccountDeletionInput) => request<Deleted>('POST', '/account/delete', b),
};

/** Set before leaving the app after the deletion of the account: the landing page shows a message once. */
export const ACCOUNT_DELETED_FLAG = 'scalo_account_deleted';

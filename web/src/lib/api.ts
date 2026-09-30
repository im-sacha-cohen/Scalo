// Typed fetch wrapper around the Scalo REST API (see SPEC.md).
import type {
  AbTestConfig,
  Broadcast,
  Campaign,
  CampaignCondition,
  CampaignEmail,
  CampaignSubscriber,
  ContactStatus,
  DnsCheckResult,
  SubscriptionStatus,
  Contact,
  ContactEvent,
  DashboardStats,
  EmailSend,
  Funnel,
  PageContent,
  QueueStatus,
  Settings,
  Step,
  StepAccess,
  StepType,
  OAuthApp,
  OAuthAppWithSecret,
  OAuthAuthorization,
  OAuthClientType,
  OAuthConsentRequest,
  OAuthScope,
  Tag,
  User,
} from '@scalo/shared';

export type StepAccessInput = Omit<StepAccess, 'password_set'> & { password?: string };

const TOKEN_KEY = 'scalo_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

function handleUnauthorized(path: string) {
  if (path.startsWith('/auth/login') || path.startsWith('/auth/register')) return;
  setToken(null);
  const here = window.location.pathname;
  if (here !== '/login' && here !== '/register') {
    window.location.href = `/login?next=${encodeURIComponent(here + window.location.search)}`;
  }
}

/** Low-level request. Returns the raw Response for non-JSON bodies. */
export async function rawRequest(method: Method, path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifiez que l’API est démarrée.', 0);
  }
  if (res.status === 401) handleUnauthorized(path);
  if (!res.ok) {
    let message = `Erreur ${res.status}`;
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') message = data.error;
    } catch {
      /* not JSON */
    }
    if (res.status === 401 && message.startsWith('Erreur')) message = 'Session expirée, veuillez vous reconnecter.';
    throw new ApiError(message, res.status);
  }
  return res;
}

export async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const res = await rawRequest(method, path, body);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

type Ok = { ok: true };
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
export type OutboxItem = EmailSend & { attempts?: number; contact_id?: number | null };
export interface OutboxQuery {
  page?: number;
  limit?: number;
  status?: OutboxStatus | '';
  broadcast_id?: number | null;
  search?: string;
}
export type ContactDetail = Contact & { events: ContactEvent[] };
export interface DeveloperAppInput {
  name: string;
  description?: string;
  website?: string | null;
  logo_url?: string | null;
  redirect_uris: string[];
  scopes: OAuthScope[];
}
export type ContactFilter = Exclude<ContactStatus, 'active'> | 'confirmed' | 'unsubscribed' | 'bounced';

export const api = {
  // auth
  register: (b: { email: string; password: string; name: string }) => request<{ token: string; user: User }>('POST', '/auth/register', b),
  login: (b: { email: string; password: string }) => request<{ token: string; user: User }>('POST', '/auth/login', b),
  me: () => request<{ user: User }>('GET', '/auth/me'),

  // OAuth authorization server: consent screen, connected applications, developer apps
  oauthRequest: (id: string) => request<OAuthConsentRequest>('GET', `/oauth/requests/${encodeURIComponent(id)}`),
  oauthConsent: (request_id: string, decision: 'approve' | 'deny') => request<{ redirect_to: string }>('POST', '/oauth/consent', { request_id, decision }),
  oauthAuthorizations: () => request<OAuthAuthorization[]>('GET', '/oauth/authorizations'),
  revokeOAuthAuthorization: (clientId: string) => request<Ok>('DELETE', `/oauth/authorizations/${encodeURIComponent(clientId)}`),
  developerApps: () => request<OAuthApp[]>('GET', '/developer/apps'),
  developerApp: (id: number) => request<OAuthApp>('GET', `/developer/apps/${id}`),
  createDeveloperApp: (b: DeveloperAppInput & { type: OAuthClientType }) => request<OAuthAppWithSecret>('POST', '/developer/apps', b),
  updateDeveloperApp: (id: number, b: Partial<DeveloperAppInput>) => request<OAuthApp>('PATCH', `/developer/apps/${id}`, b),
  rotateDeveloperSecret: (id: number) => request<OAuthAppWithSecret>('POST', `/developer/apps/${id}/rotate-secret`),
  deleteDeveloperApp: (id: number) => request<Ok>('DELETE', `/developer/apps/${id}`),

  dashboard: () => request<DashboardStats>('GET', '/dashboard'),

  // contacts
  contacts: (p: { search?: string; tag_id?: number | ''; status?: ContactFilter | ''; segment_id?: number | ''; page?: number; limit?: number }) =>
    request<{ items: Contact[]; total: number }>('GET', `/contacts${qs(p)}`),
  createContact: (b: { email: string; first_name?: string; last_name?: string; phone?: string; tags?: string[]; fields?: Record<string, string | number | boolean | null> }) =>
    request<Contact>('POST', '/contacts', b),
  contact: (id: number) => request<ContactDetail>('GET', `/contacts/${id}`),
  updateContact: (id: number, b: Partial<Pick<Contact, 'email' | 'first_name' | 'last_name' | 'phone'>> & { unsubscribed?: boolean; fields?: Record<string, string | number | boolean | null> }) =>
    request<Contact>('PATCH', `/contacts/${id}`, b),
  deleteContact: (id: number) => request<Ok>('DELETE', `/contacts/${id}`),
  addContactTag: (id: number, name: string) => request<Contact>('POST', `/contacts/${id}/tags`, { name }),
  removeContactTag: (id: number, tagId: number) => request<Contact>('DELETE', `/contacts/${id}/tags/${tagId}`),
  importContacts: (b: { csv: string; tag?: string }) =>
    request<{ created: number; updated: number; skipped: number; fields?: string[]; invalid_values?: number }>('POST', '/contacts/import', b),
  exportContacts: async () => (await rawRequest('GET', '/contacts/export')).blob(),
  resendConfirmation: (id: number) => request<Contact>('POST', `/contacts/${id}/resend-confirmation`),

  tags: () => request<Tag[]>('GET', '/tags'),
  createTag: (name: string) => request<Tag>('POST', '/tags', { name }),
  deleteTag: (id: number) => request<Ok>('DELETE', `/tags/${id}`),

  // funnels
  funnels: () => request<Funnel[]>('GET', '/funnels'),
  createFunnel: (b: { name: string; template: string; kit?: string; flow?: string }) => request<Funnel>('POST', '/funnels', b),
  funnel: (id: number) => request<Funnel>('GET', `/funnels/${id}`),
  updateFunnel: (id: number, b: { name?: string; slug?: string }) => request<Funnel>('PATCH', `/funnels/${id}`, b),
  deleteFunnel: (id: number) => request<Ok>('DELETE', `/funnels/${id}`),
  duplicateFunnel: (id: number) => request<Funnel>('POST', `/funnels/${id}/duplicate`),
  createStep: (funnelId: number, b: { name: string; type: StepType; content?: PageContent }) => request<Step>('POST', `/funnels/${funnelId}/steps`, b),
  reorderSteps: (funnelId: number, ids: number[]) => request<Step[]>('POST', `/funnels/${funnelId}/steps/reorder`, { ids }),
  step: (id: number) => request<Step>('GET', `/steps/${id}`),
  updateStep: (id: number, b: { name?: string; slug?: string; type?: StepType; content?: PageContent; access?: StepAccessInput }) =>
    request<Step>('PATCH', `/steps/${id}`, b),
  deleteStep: (id: number) => request<Ok>('DELETE', `/steps/${id}`),

  // broadcasts
  broadcasts: () => request<Broadcast[]>('GET', '/broadcasts'),
  createBroadcast: (subject: string, content?: PageContent) => request<Broadcast>('POST', '/broadcasts', { subject, ...(content ? { content } : {}) }),
  broadcast: (id: number) => request<Broadcast>('GET', `/broadcasts/${id}`),
  updateBroadcast: (id: number, b: { subject?: string; content?: PageContent; tag_id?: number | null; segment_id?: number | null; ab_test?: AbTestConfig | null }) =>
    request<Broadcast>('PATCH', `/broadcasts/${id}`, b),
  scheduleBroadcast: (id: number, scheduled_at: string) => request<Broadcast>('POST', `/broadcasts/${id}/schedule`, { scheduled_at }),
  unscheduleBroadcast: (id: number) => request<Broadcast>('POST', `/broadcasts/${id}/unschedule`),
  deleteBroadcast: (id: number) => request<Ok>('DELETE', `/broadcasts/${id}`),
  recipientsCount: (id: number) => request<{ count: number }>('GET', `/broadcasts/${id}/recipients-count`),
  sendBroadcast: (id: number) => request<Broadcast>('POST', `/broadcasts/${id}/send`),
  testBroadcast: (id: number, email: string) => request<Ok>('POST', `/broadcasts/${id}/test`, { email }),

  // campaigns
  campaigns: () => request<Campaign[]>('GET', '/campaigns'),
  createCampaign: (b: { name: string; trigger_tag_id?: number | null }) => request<Campaign>('POST', '/campaigns', b),
  campaign: (id: number) => request<Campaign>('GET', `/campaigns/${id}`),
  updateCampaign: (id: number, b: { name?: string; trigger_tag_id?: number | null; stop_tag_id?: number | null }) => request<Campaign>('PATCH', `/campaigns/${id}`, b),
  deleteCampaign: (id: number) => request<Ok>('DELETE', `/campaigns/${id}`),
  createCampaignEmail: (campaignId: number, b: { subject: string; delay_days: number; condition?: CampaignCondition | null; apply_to_existing?: boolean; content?: PageContent }) =>
    request<CampaignEmail & { backfilled: number }>('POST', `/campaigns/${campaignId}/emails`, b),
  updateCampaignEmail: (id: number, b: { subject?: string; content?: PageContent; delay_days?: number; condition?: CampaignCondition | null }) =>
    request<CampaignEmail>('PATCH', `/campaign-emails/${id}`, b),
  reorderCampaignEmails: (campaignId: number, ids: number[]) => request<Campaign>('POST', `/campaigns/${campaignId}/emails/reorder`, { ids }),
  campaignSubscribers: (campaignId: number, p: { page?: number; limit?: number; status?: SubscriptionStatus | ''; search?: string }) =>
    request<{ items: CampaignSubscriber[]; total: number }>('GET', `/campaigns/${campaignId}/subscribers${qs(p)}`),
  unsubscribeFromCampaign: (campaignId: number, contactId: number) => request<Ok>('POST', `/campaigns/${campaignId}/subscribers/${contactId}/unsubscribe`),
  deleteCampaignEmail: (id: number) => request<Ok>('DELETE', `/campaign-emails/${id}`),
  enroll: (campaignId: number, contact_id: number) => request<Ok>('POST', `/campaigns/${campaignId}/enroll`, { contact_id }),

  // outbox & sending queue
  outbox: (p: OutboxQuery) =>
    request<{ items: OutboxItem[]; total: number }>(
      'GET',
      `/emails/outbox${qs({ page: p.page, limit: p.limit, status: p.status, broadcast_id: p.broadcast_id, search: p.search?.trim() })}`,
    ),
  sendHtml: async (id: number) => (await rawRequest('GET', `/emails/sends/${id}/html`)).text(),
  retrySend: (id: number) => request<OutboxItem>('POST', `/emails/sends/${id}/retry`),
  queue: () => request<QueueStatus>('GET', '/emails/queue'),
  pauseQueue: () => request<QueueStatus>('POST', '/emails/queue/pause'),
  resumeQueue: () => request<QueueStatus>('POST', '/emails/queue/resume'),
  retryFailed: (broadcast_id?: number) =>
    request<{ count: number }>('POST', '/emails/queue/retry-failed', broadcast_id ? { broadcast_id } : {}),
  cancelBroadcastSends: (broadcast_id: number) => request<{ count: number }>('POST', '/emails/queue/cancel', { broadcast_id }),

  // settings
  settings: () => request<Settings>('GET', '/settings'),
  saveSettings: (b: Partial<Settings>) => request<Settings>('PUT', '/settings', b),
  testSmtp: () => request<Ok>('POST', '/settings/test-smtp'),
  rotateWebhookSecret: () => request<Settings>('POST', '/settings/webhook-secret'),
  dnsCheck: (b: { domain?: string; selectors?: string } = {}) => request<DnsCheckResult>('POST', '/settings/dns-check', b),

  // image uploads (builder media library)
  uploads: () => request<UploadItem[]>('GET', '/uploads'),
  upload: (file: Blob) => uploadImage(file),
  deleteUpload: (name: string) => request<Ok>('DELETE', `/uploads/${encodeURIComponent(name)}`),
};

export interface UploadItem { name: string; url: string; size: number; created_at: string }

async function uploadImage(file: Blob): Promise<UploadItem> {
  if (file.size > 8 * 1024 * 1024) throw new ApiError('Image trop lourde (8 Mo maximum)', 413);
  const headers: Record<string, string> = { 'Content-Type': file.type || 'application/octet-stream' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch('/api/uploads', { method: 'POST', headers, body: file });
  } catch {
    throw new ApiError('Impossible de joindre le serveur. Vérifiez que l’API est démarrée.', 0);
  }
  if (res.status === 401) handleUnauthorized('/uploads');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data && typeof data.error === 'string' ? data.error : `Erreur ${res.status}`, res.status);
  return data as UploadItem;
}

/** Triggers a browser download of a Blob. */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

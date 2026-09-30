// Read-only client of the systeme.io public API, used to migrate the contacts of an account into Scalo.
//
// What the public developer documentation states (https://developer.systeme.io/reference/api): base URL
// `https://api.systeme.io/api`, key in the `X-API-Key` header, cursor pagination (`limit`, `startingAfter`, `order`),
// list responses `{ items, hasMore }`, rate-limit headers `X-RateLimit-Limit|Remaining|Refill` and `Retry-After` on 429.
// The exact shape of a contact could not be checked against a live account: the parser below is deliberately tolerant
// (several spellings accepted, unknown attributes ignored) — see `parseContact`.
//
// The API key is only ever sent to api.systeme.io, never logged and never part of an error message.

export const SYSTEME_IO_BASE = 'https://api.systeme.io/api';
const TIMEOUT_MS = 20_000;
const MIN_WAIT_MS = 1_000;
const MAX_WAIT_MS = 15 * 60_000;
const DEFAULT_WAIT_MS = 10_000;

export interface SioContact {
  id: string;
  email: string;
  registeredAt: string | null;
  unsubscribed: boolean;
  bounced: boolean;
  needsConfirmation: boolean;
  /** slug → value (non-empty values only) */
  fields: Record<string, string>;
  /** slug → label, when the API gives one */
  fieldLabels: Record<string, string>;
  tags: string[];
}

export interface SioPage<T> {
  items: T[];
  hasMore: boolean;
  /** Set when the quota is exhausted after this call: wait this long before the next one. */
  waitMs: number | null;
}

export type SioErrorKind = 'auth' | 'rate_limit' | 'http' | 'network' | 'format';
export class SioError extends Error {
  constructor(
    public kind: SioErrorKind,
    message: string,
    public retryAfterMs: number | null = null,
    public status: number | null = null,
  ) {
    super(message);
  }
}

let fetchImpl: typeof fetch = (...a) => fetch(...a);
/** Tests: fake systeme.io server. `null` restores the real fetch. */
export function setSystemeIoFetch(f: typeof fetch | null) {
  fetchImpl = f ?? ((...a) => fetch(...a));
}

const clampWait = (ms: number) => Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(ms)));

/** `Retry-After` (seconds or HTTP date) or `X-RateLimit-Refill` (seconds, unix timestamp or date) → milliseconds. */
export function parseWait(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e12) return clampWait(n - now); // unix ms
    if (n > 1e9) return clampWait(n * 1000 - now); // unix s
    return clampWait(n * 1000); // delta seconds
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : clampWait(t - now);
}

function waitFromHeaders(h: Headers): number {
  return parseWait(h.get('retry-after')) ?? parseWait(h.get('x-ratelimit-refill')) ?? DEFAULT_WAIT_MS;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
const bool = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true';

/** Tolerant: accepts camelCase / snake_case spellings, `fields` as an array of {slug, value} or as an object. */
export function parseContact(raw: unknown): SioContact | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id);
  const email = str(o.email).trim();
  if (!id && !email) return null;
  const fields: Record<string, string> = {};
  const fieldLabels: Record<string, string> = {};
  if (Array.isArray(o.fields)) {
    for (const f of o.fields) {
      if (!f || typeof f !== 'object') continue;
      const fo = f as Record<string, unknown>;
      const slug = str(fo.slug).trim();
      if (!slug) continue;
      const label = str(fo.fieldName ?? fo.field_name ?? fo.name).trim();
      if (label) fieldLabels[slug] = label;
      const value = str(fo.value).trim();
      if (value) fields[slug] = value;
    }
  } else if (o.fields && typeof o.fields === 'object') {
    for (const [slug, v] of Object.entries(o.fields as Record<string, unknown>)) {
      const value = str(v).trim();
      if (value) fields[slug] = value;
    }
  }
  const tags: string[] = [];
  if (Array.isArray(o.tags)) {
    for (const t of o.tags) {
      const name = (typeof t === 'string' ? t : str((t as Record<string, unknown> | null)?.name)).trim();
      if (name) tags.push(name);
    }
  }
  return {
    id,
    email,
    registeredAt: str(o.registeredAt ?? o.registered_at ?? o.createdAt ?? o.created_at) || null,
    unsubscribed: bool(o.unsubscribed),
    bounced: bool(o.bounced),
    needsConfirmation: bool(o.needsConfirmation ?? o.needs_confirmation),
    fields,
    fieldLabels,
    tags,
  };
}

async function get(apiKey: string, path: string, params: Record<string, string | number | null | undefined>): Promise<{ body: unknown; headers: Headers }> {
  const url = new URL(`${SYSTEME_IO_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey, Accept: 'application/json', 'User-Agent': 'Scalo-Import/1.0' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // never include the request (and its key) in the message
    const name = (e as { name?: string })?.name;
    throw new SioError('network', name === 'TimeoutError' || name === 'AbortError' ? 'systeme.io ne répond pas (délai dépassé)' : 'Connexion à systeme.io impossible');
  }
  if (res.status === 429) {
    await res.body?.cancel().catch(() => undefined);
    throw new SioError('rate_limit', 'Limite de débit de systeme.io atteinte', waitFromHeaders(res.headers), 429);
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    throw new SioError('auth', 'Clé API systeme.io refusée. Vérifiez la clé (Paramètres → Clés API publiques dans systeme.io).', null, res.status);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new SioError('http', `systeme.io a répondu avec une erreur (HTTP ${res.status})`, res.status >= 500 ? waitFromHeaders(res.headers) : null, res.status);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new SioError('format', 'Réponse de systeme.io illisible (JSON attendu)');
  }
  return { body, headers: res.headers };
}

function toPage<T>(body: unknown, headers: Headers, limit: number, parse: (v: unknown) => T | null): SioPage<T> {
  const o = body as Record<string, unknown> | unknown[] | null;
  const rawItems = Array.isArray(o) ? o : Array.isArray(o?.items) ? (o!.items as unknown[]) : Array.isArray((o as Record<string, unknown> | null)?.data) ? ((o as Record<string, unknown>).data as unknown[]) : null;
  if (!rawItems) throw new SioError('format', 'Réponse de systeme.io inattendue (liste « items » absente)');
  const hasMoreRaw = Array.isArray(o) ? undefined : (o as Record<string, unknown>).hasMore ?? (o as Record<string, unknown>).has_more;
  const hasMore = typeof hasMoreRaw === 'boolean' ? hasMoreRaw : rawItems.length >= limit;
  const remaining = headers.get('x-ratelimit-remaining');
  const waitMs = remaining !== null && /^\d+$/.test(remaining.trim()) && Number(remaining) <= 0 && hasMore ? waitFromHeaders(headers) : null;
  return { items: rawItems.map(parse).filter((v): v is T => v !== null), hasMore, waitMs };
}

/** One page of contacts, oldest first, after the contact `startingAfter`. */
export async function listSioContacts(apiKey: string, opts: { startingAfter?: string | null; limit?: number } = {}): Promise<SioPage<SioContact> & { lastId: string | null }> {
  const limit = opts.limit ?? 100;
  const { body, headers } = await get(apiKey, '/contacts', { limit, order: 'asc', startingAfter: opts.startingAfter });
  const page = toPage(body, headers, limit, parseContact);
  const last = page.items[page.items.length - 1];
  return { ...page, lastId: last?.id || null };
}

/** Custom field definitions (slug → label). Optional: the import works from the contacts alone when this call fails. */
export async function listSioFields(apiKey: string): Promise<Record<string, string>> {
  const { body, headers } = await get(apiKey, '/contact_fields', {});
  const page = toPage(body, headers, 100, (v) => {
    const o = v as Record<string, unknown> | null;
    const slug = str(o?.slug).trim();
    return slug ? { slug, label: str(o?.fieldName ?? o?.field_name ?? o?.name).trim() || slug } : null;
  });
  return Object.fromEntries(page.items.map((f) => [f.slug, f.label]));
}

/** Tag names of the account (first pages only: informative, the import reads the tags carried by each contact). */
export async function listSioTags(apiKey: string, maxPages = 5): Promise<string[]> {
  const names: string[] = [];
  let after: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const { body, headers } = await get(apiKey, '/tags', { limit: 100, order: 'asc', startingAfter: after });
    const page = toPage(body, headers, 100, (v) => {
      const o = v as Record<string, unknown> | null;
      const name = str(o?.name).trim();
      return name ? { id: str(o?.id), name } : null;
    });
    names.push(...page.items.map((t) => t.name));
    const last = page.items[page.items.length - 1];
    if (!page.hasMore || !last?.id || page.waitMs) break;
    after = last.id;
  }
  return names;
}

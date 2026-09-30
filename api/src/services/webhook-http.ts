// Outgoing webhooks (automation action): POST JSON signed with HMAC-SHA256, protected against SSRF.
//
// - https only, no credentials in the URL;
// - the host is resolved and EVERY address must be public (no loopback / private / link-local / CGNAT / multicast /
//   reserved / IPv4-mapped private…); the connection is then pinned to the validated address (no DNS rebinding
//   between the check and the connection);
// - 5 s timeout, redirects are not followed (a 3xx is a failure), the response body is discarded (64 KB read max).
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

export const WEBHOOK_TIMEOUT_MS = 5000;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export interface WebhookResponse {
  status: number;
}
export interface WebhookDeps {
  lookup: (hostname: string) => Promise<ResolvedAddress[]>;
  /** Sends the request to the validated `address` (TLS name = url.hostname). */
  transport: (url: URL, address: ResolvedAddress, init: { headers: Record<string, string>; body: string }) => Promise<WebhookResponse>;
}

const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64],
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4 (embeds an IPv4)
] as const) blocked.addSubnet(net6, prefix, 'ipv6');

/** true when the address is not a public unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return blocked.check(ip, 'ipv4');
  if (v !== 6) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped / -compatible / NAT64: check the embedded IPv4
  const embedded = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (embedded) return isPrivateAddress(embedded[1]);
  const mappedHex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return blocked.check(ip, 'ipv6');
}

/** Static checks of a webhook URL (at save time and before each call). Returns a French error or null. */
export function webhookUrlError(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'URL invalide';
  }
  if (u.protocol !== 'https:') return 'L’URL du webhook doit commencer par https://';
  if (u.username || u.password) return 'L’URL du webhook ne doit pas contenir d’identifiants';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'URL invalide';
  if (net.isIP(host) && isPrivateAddress(host)) return 'Adresse IP privée ou réservée refusée';
  if (/^(localhost|localhost\.localdomain)$/i.test(host) || /\.(localhost|local|internal)$/i.test(host)) return 'Adresse locale refusée';
  return null;
}

const defaultDeps: WebhookDeps = {
  lookup: async (hostname) => (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
  transport: (url, address, init) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        {
          protocol: 'https:',
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || 443,
          path: `${url.pathname}${url.search}`,
          method: 'POST',
          headers: { ...init.headers, 'Content-Length': String(Buffer.byteLength(init.body)) },
          servername: net.isIP(url.hostname) ? undefined : url.hostname,
          // pinned to the validated address: a second DNS answer cannot redirect the connection
          lookup: ((_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => {
            if (opts?.all) cb(null, [{ address: address.address, family: address.family }]);
            else cb(null, address.address, address.family);
          }) as never,
          timeout: WEBHOOK_TIMEOUT_MS,
          agent: false,
        },
        (res) => {
          let read = 0;
          res.on('data', (chunk: Buffer) => {
            read += chunk.length;
            if (read > 64 * 1024) res.destroy();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('close', () => resolve({ status: res.statusCode ?? 0 }));
          res.on('error', () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`délai dépassé (${WEBHOOK_TIMEOUT_MS / 1000} s)`)));
      req.on('error', reject);
      req.end(init.body);
    }),
};

let deps: WebhookDeps = defaultDeps;

/** Tests: fake DNS / transport. `null` restores the real ones. */
export function setWebhookDeps(d: Partial<WebhookDeps> | null) {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>` (Stripe-like: the timestamp prevents replays). */
export function signPayload(secret: string, body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

export type WebhookResult = { ok: true; status: number } | { ok: false; error: string; status?: number };

export async function postWebhook(rawUrl: string, payload: unknown, opts: { secret: string; deliveryId: string; event: string }): Promise<WebhookResult> {
  const err = webhookUrlError(rawUrl);
  if (err) return { ok: false, error: err };
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: ResolvedAddress[];
  try {
    addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) === 6 ? 6 : 4 }] : await deps.lookup(host);
  } catch (e) {
    return { ok: false, error: `Nom de domaine introuvable (${(e as { code?: string }).code ?? 'DNS'})` };
  }
  if (!addresses.length) return { ok: false, error: 'Nom de domaine introuvable' };
  // every answer must be public: otherwise the connection could be steered to an internal address
  const bad = addresses.find((a) => isPrivateAddress(a.address));
  if (bad) return { ok: false, error: `Adresse ${bad.address} refusée (réseau privé, local ou réservé)` };
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Scalo-Webhooks/1.0',
    'X-Scalo-Event': opts.event,
    'X-Scalo-Delivery': opts.deliveryId,
    'X-Scalo-Signature': signPayload(opts.secret, body),
  };
  try {
    const res = await Promise.race([
      deps.transport(url, addresses[0], { headers, body }),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`délai dépassé (${WEBHOOK_TIMEOUT_MS / 1000} s)`)), WEBHOOK_TIMEOUT_MS + 500).unref()),
    ]);
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
    if (res.status >= 300 && res.status < 400) return { ok: false, status: res.status, error: `Redirection ${res.status} non suivie` };
    return { ok: false, status: res.status, error: `Réponse HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: `Échec de l’appel : ${e instanceof Error ? e.message : String(e)}` };
  }
}

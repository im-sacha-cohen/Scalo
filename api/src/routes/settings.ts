import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db';
import { getSettingsRow, publicSettings, resetTransport, smtpConfigured, verifySmtp } from '../services/email';
import { checkDomain, DEFAULT_DKIM_SELECTORS, normalizeDomain, parseSelectors, systemResolver, type DnsResolver } from '../services/dns';
import { HttpError, uid } from '../util';

const s = (max: number) => z.string().trim().max(max);
const schema = z.object({
  sender_name: s(120).optional(),
  sender_email: z.union([z.email().max(254), z.literal('')]).optional(),
  company_address: s(500).optional(),
  smtp_host: s(255).optional(),
  smtp_port: z.coerce.number().int().min(1).max(65535).optional(),
  smtp_user: s(255).optional(),
  smtp_pass: z.string().max(500).optional(),
  smtp_secure: z.boolean().optional(),
  smtp_configured: z.boolean().optional(), // ignored (read-only)
  rate_per_minute: z.coerce.number().int().min(1).max(1000).optional(),
  daily_limit: z.coerce.number().int().min(0).max(1_000_000).optional(),
  double_optin_default: z.boolean().optional(),
  dkim_selectors: s(300).optional(),
  webhook_secret: z.string().optional(), // ignored (read-only, rotate via POST /settings/webhook-secret)
  webhook_base_url: z.string().optional(), // ignored
});

const newSecret = () => crypto.randomBytes(24).toString('base64url');

/** The provider webhook secret, generated on first use. */
async function ensureWebhookSecret(userId: number) {
  await db.updateTable('settings').set({ webhook_secret: newSecret() }).where('user_id', '=', userId).where('webhook_secret', 'is', null).execute();
}

export interface SettingsRouterOptions {
  /** DNS resolver of the domain check (tests inject a fake one). */
  dns?: DnsResolver;
}

export function createSettingsRouter(opts: SettingsRouterOptions = {}) {
  const router = Router();
  const resolver = opts.dns ?? systemResolver();

  router.get('/settings', async (req, res) => {
    const userId = uid(req);
    await getSettingsRow(userId);
    await ensureWebhookSecret(userId);
    const out = publicSettings(await getSettingsRow(userId));
    // team members below admin can read the settings but not the provider webhook secret
    if (req.role === 'editor' || req.role === 'viewer') (out as { webhook_secret?: string | null }).webhook_secret = null;
    res.json(out);
  });

  router.put('/settings', async (req, res) => {
    const userId = uid(req);
    const body = schema.parse(req.body);
    const cur = await getSettingsRow(userId);
    await db
      .updateTable('settings')
      .set({
        sender_name: body.sender_name ?? cur.sender_name,
        sender_email: body.sender_email ?? cur.sender_email,
        company_address: body.company_address ?? cur.company_address,
        smtp_host: body.smtp_host ?? cur.smtp_host,
        smtp_port: body.smtp_port ?? cur.smtp_port,
        smtp_user: body.smtp_user ?? cur.smtp_user,
        smtp_pass: body.smtp_pass ? body.smtp_pass : cur.smtp_pass, // empty = unchanged
        smtp_secure: body.smtp_secure ?? cur.smtp_secure,
        rate_per_minute: body.rate_per_minute ?? cur.rate_per_minute,
        daily_limit: body.daily_limit ?? cur.daily_limit,
        double_optin_default: body.double_optin_default ?? cur.double_optin_default,
        dkim_selectors: body.dkim_selectors !== undefined ? parseSelectors(body.dkim_selectors).join(', ') : cur.dkim_selectors,
      })
      .where('user_id', '=', userId)
      .execute();
    resetTransport(userId); // pick up new SMTP settings on the next send
    await ensureWebhookSecret(userId);
    res.json(publicSettings(await getSettingsRow(userId)));
  });

  router.post('/settings/test-smtp', async (req, res) => {
    const settings = await getSettingsRow(uid(req));
    if (!smtpConfigured(settings)) throw new HttpError(400, 'Aucun serveur SMTP configuré');
    try {
      await verifySmtp(settings);
    } catch (e) {
      throw new HttpError(502, `Connexion SMTP impossible : ${e instanceof Error ? e.message : String(e)}`);
    }
    res.json({ ok: true });
  });

  /** New webhook secret: the previous URL stops working immediately. */
  router.post('/settings/webhook-secret', async (req, res) => {
    const userId = uid(req);
    await getSettingsRow(userId);
    await db.updateTable('settings').set({ webhook_secret: newSecret() }).where('user_id', '=', userId).execute();
    res.json(publicSettings(await getSettingsRow(userId)));
  });

  /**
   * SPF / DKIM / DMARC / MX of the sender domain (or `domain` to check another one, e.g. before changing the sender).
   * DNS lookups only, with timeouts; the domain syntax is validated first.
   */
  router.post('/settings/dns-check', async (req, res) => {
    const userId = uid(req);
    const body = z
      .object({ domain: z.string().trim().max(253).optional(), selectors: z.union([z.string().max(300), z.array(z.string().max(63)).max(20)]).optional() })
      .parse(req.body ?? {});
    const settings = await getSettingsRow(userId);
    const raw = body.domain || settings.sender_email.split('@')[1] || '';
    if (!raw) throw new HttpError(400, 'Renseignez d’abord l’email de l’expéditeur (ou un domaine à vérifier)');
    const domain = normalizeDomain(raw);
    if (!domain) throw new HttpError(400, 'Nom de domaine invalide');
    const custom = parseSelectors(body.selectors ?? settings.dkim_selectors);
    const selectors = [...new Set([...custom, ...DEFAULT_DKIM_SELECTORS])].slice(0, 20);
    res.json(await checkDomain(resolver, domain, { selectors, smtpHost: settings.smtp_host }));
  });

  return router;
}

// Provider webhooks (public, authenticated by the per-account secret in the URL):
//   POST /api/webhooks/email/:provider/:secret   provider = generic | ses | postmark | mailgun | brevo
// Complaint → contact unsubscribed + `complained`, pending sends cancelled, event `spam_complaint`, complaint-rate
// auto-pause; hard bounce → same as an SMTP 5xx on the recipient. Unknown provider / bad secret → 404.
import express, { Router } from 'express';
import { db } from '../db';
import { isAwsSubscribeUrl, parsePayload, PROVIDERS, recordFeedback, type Provider } from '../services/feedback';

export interface WebhooksOptions {
  /** fetch used to confirm SNS subscriptions (tests inject a mock). */
  fetch?: typeof fetch;
}

export function createWebhooksRouter(opts: WebhooksOptions = {}) {
  const router = Router();
  const doFetch = opts.fetch ?? fetch;

  // SNS posts JSON with Content-Type text/plain: read any body as text when express.json did not parse it.
  router.post('/email/:provider/:secret', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
    const provider = String(req.params.provider) as Provider;
    const secret = String(req.params.secret);
    if (!PROVIDERS.includes(provider) || !/^[\w-]{20,100}$/.test(secret)) return res.status(404).json({ error: 'Webhook introuvable' });
    const account = await db.selectFrom('settings').select('user_id').where('webhook_secret', '=', secret).executeTakeFirst();
    if (!account) return res.status(404).json({ error: 'Webhook introuvable' });

    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = body.trim() ? JSON.parse(body) : {};
      } catch {
        return res.status(400).json({ error: 'JSON invalide' });
      }
    }
    const parsed = parsePayload(provider, body);
    if (!parsed) return res.status(400).json({ error: 'Format de notification non reconnu' });

    if (parsed.subscribeUrl !== undefined) {
      if (!isAwsSubscribeUrl(parsed.subscribeUrl)) return res.status(400).json({ error: 'SubscribeURL refusée (seules les URL https *.amazonaws.com sont acceptées)' });
      try {
        const r = await doFetch(parsed.subscribeUrl, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (!r.ok) return res.status(502).json({ error: `Confirmation SNS refusée (${r.status})` });
      } catch (e) {
        return res.status(502).json({ error: `Confirmation SNS impossible : ${e instanceof Error ? e.message : String(e)}` });
      }
      return res.json({ ok: true, subscribed: true });
    }

    const results: string[] = [];
    for (const ev of parsed.events.slice(0, 100)) results.push(await recordFeedback(account.user_id, ev, provider));
    res.json({ ok: true, processed: results.length, results });
  });

  return router;
}

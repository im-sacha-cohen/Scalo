// Native AI (Claude API) — session-authenticated routes under /api/ai:
//   GET    /ai/status            key configured?, model, rate limit
//   PUT    /ai/key               store the account's Anthropic API key (encrypted, never returned)
//   DELETE /ai/key
//   GET    /ai/usage             usage log (tokens) + totals of the last 30 days
//   POST   /ai/funnels           brief → funnel + steps            (202, asynchronous)
//   POST   /ai/campaigns         brief → campaign of N emails      (202, asynchronous)
//   POST   /ai/newsletters       brief → newsletter draft          (202, asynchronous)
//   GET    /ai/generations/:id   state of an asynchronous generation
//   POST   /ai/rewrite           rewrite a text of the builder
//   POST   /ai/subjects          subject ideas (A/B test)
import { Router } from 'express';
import { z } from 'zod';
import { isRichHtml, richToPlain } from '@scalo/shared';
import { db, nowIso } from '../db';
import { notFound, paramId, uid } from '../util';
import { aiDeps, aiStatus, deleteAccountKey, getGeneration, runNow, saveAccountKey, startGeneration, usage, type AiOptions } from '../services/ai';
import { AiError } from '../services/ai-client';
import {
  buildEmail,
  buildFunnel,
  campaignBriefSchema,
  campaignOutputSchema,
  campaignPrompt,
  clampDelay,
  cleanText,
  funnelBriefSchema,
  funnelOutputSchema,
  funnelPrompt,
  newsletterBriefSchema,
  newsletterOutputSchema,
  newsletterPrompt,
  rewriteInputSchema,
  rewriteOutputSchema,
  rewritePrompt,
  subjectsInputSchema,
  subjectsOutputSchema,
  subjectsPrompt,
} from '../services/ai-content';
import { insertStep, uniqueFunnelSlug, withFreeSlug } from './funnels';

const keySchema = z.strictObject({
  api_key: z
    .string()
    .trim()
    .regex(/^sk-ant-[A-Za-z0-9_-]{20,300}$/, 'Clé API invalide : elle commence par « sk-ant- » (console.anthropic.com → API keys)'),
});

export function createAiRouter(opts: AiOptions = {}) {
  const r = Router();
  const deps = aiDeps(opts);

  r.get('/status', async (req, res) => {
    res.json(await aiStatus(uid(req), deps));
  });

  r.put('/key', async (req, res) => {
    const userId = uid(req);
    await saveAccountKey(userId, keySchema.parse(req.body).api_key);
    res.json(await aiStatus(userId, deps));
  });

  r.delete('/key', async (req, res) => {
    const userId = uid(req);
    await deleteAccountKey(userId);
    res.json(await aiStatus(userId, deps));
  });

  r.get('/usage', async (req, res) => {
    res.json(await usage(uid(req), deps));
  });

  r.get('/generations/:id', async (req, res) => {
    const g = await getGeneration(uid(req), paramId(req.params.id, 'Génération'), deps);
    if (!g) throw notFound('Génération');
    res.json(g);
  });

  // ----- funnel -----

  r.post('/funnels', async (req, res) => {
    const userId = uid(req);
    const brief = funnelBriefSchema.parse(req.body);
    const id = await startGeneration(
      userId,
      deps,
      { kind: 'funnel', label: brief.offer, ...funnelPrompt(brief), schema: funnelOutputSchema, maxTokens: 32_000, effort: 'medium' },
      async (out) => {
        const funnel = buildFunnel(out, brief.goal);
        if (!funnel) throw new AiError('invalid_output');
        const funnelId = await withFreeSlug(db, async (trx) => {
          const f = await trx
            .insertInto('funnels')
            .values({ user_id: userId, name: funnel.name, slug: await uniqueFunnelSlug(funnel.name, trx), created_at: nowIso() })
            .returning('id')
            .executeTakeFirstOrThrow();
          for (const s of funnel.steps) await insertStep(trx, f.id, s);
          return f.id;
        });
        return { funnel_id: funnelId };
      },
    );
    res.status(202).json({ id, status: 'running' });
  });

  // ----- campaign (email sequence) -----

  r.post('/campaigns', async (req, res) => {
    const userId = uid(req);
    const brief = campaignBriefSchema.parse(req.body);
    const id = await startGeneration(
      userId,
      deps,
      { kind: 'campaign', label: brief.offer, ...campaignPrompt(brief), schema: campaignOutputSchema, maxTokens: 32_000, effort: 'medium' },
      async (out) => {
        const emails = out.emails
          .slice(0, brief.emails)
          .map((e, i) => ({ email: buildEmail(e, brief.link_url), delay_days: clampDelay(e.delay_days, i === 0) }))
          .filter((e): e is { email: NonNullable<ReturnType<typeof buildEmail>>; delay_days: number } => !!e.email);
        if (!emails.length) throw new AiError('invalid_output');
        const campaignId = await db.transaction().execute(async (trx) => {
          // no trigger tag: the user chooses when the sequence starts (nothing is sent by a generation)
          const c = await trx
            .insertInto('campaigns')
            .values({ user_id: userId, name: cleanText(out.name, 120) || 'Campagne générée par IA', trigger_tag_id: null, stop_tag_id: null, created_at: nowIso() })
            .returning('id')
            .executeTakeFirstOrThrow();
          await trx
            .insertInto('campaign_emails')
            .values(emails.map((e, position) => ({ campaign_id: c.id, subject: e.email.subject, content: JSON.stringify(e.email.content), delay_days: e.delay_days, position, condition: null })))
            .execute();
          return c.id;
        });
        return { campaign_id: campaignId, emails: emails.length };
      },
    );
    res.status(202).json({ id, status: 'running' });
  });

  // ----- newsletter (draft) -----

  r.post('/newsletters', async (req, res) => {
    const userId = uid(req);
    const brief = newsletterBriefSchema.parse(req.body);
    const id = await startGeneration(
      userId,
      deps,
      { kind: 'newsletter', label: brief.offer, ...newsletterPrompt(brief), schema: newsletterOutputSchema, maxTokens: 16_000, effort: 'medium' },
      async (out) => {
        const email = buildEmail(out, brief.link_url);
        if (!email) throw new AiError('invalid_output');
        const b = await db
          .insertInto('broadcasts')
          .values({ user_id: userId, subject: email.subject, content: JSON.stringify(email.content), status: 'draft', created_at: nowIso() })
          .returning('id')
          .executeTakeFirstOrThrow();
        return { broadcast_id: b.id };
      },
    );
    res.status(202).json({ id, status: 'running' });
  });

  // ----- builder: rewrite a text -----

  r.post('/rewrite', async (req, res) => {
    const input = rewriteInputSchema.parse(req.body);
    // rich HTML (sanitized subset) → plain text: the model never sees nor returns markup
    const source = (isRichHtml(input.text) ? richToPlain(input.text) : input.text).trim();
    if (!source) return res.json({ text: '' });
    const out = await runNow(uid(req), deps, {
      kind: 'rewrite',
      label: `${input.action} · ${source.slice(0, 80)}`,
      ...rewritePrompt(source, input.action, input.language),
      schema: rewriteOutputSchema,
      maxTokens: 8000,
      effort: 'low',
    });
    res.json({ text: cleanText(out.text, 6000) });
  });

  // ----- emails: subject ideas (A/B test) -----

  r.post('/subjects', async (req, res) => {
    const input = subjectsInputSchema.parse(req.body);
    const out = await runNow(uid(req), deps, {
      kind: 'subjects',
      label: input.subject || input.content.slice(0, 80) || 'Objets',
      ...subjectsPrompt(input),
      schema: subjectsOutputSchema,
      maxTokens: 4000,
      effort: 'low',
    });
    const subjects = [...new Set(out.subjects.map((s) => cleanText(s, 250).replace(/\s*\n\s*/g, ' ')).filter(Boolean))].slice(0, input.count);
    res.json({ subjects });
  });

  return r;
}

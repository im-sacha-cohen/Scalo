// Public API v1 — writing emails: newsletters (draft, edit, test, schedule) and campaigns (create, add / edit emails).
// Mounted by routes/v1.ts (same auth, rate limit and scope checks). The operations are those of the web app
// (routes/emails.ts); this module only turns the text format below into email content and tag names into tags.
//
// Text format: `paragraphs` (markdown subset **gras**, *italique*, [lien](url), {{first_name}}…), optional `preheader`
// and button (`button_label` + `button_url`). Sending a newsletter is always a scheduled send (`/schedule`).
import type { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import type { OAuthScope } from '@scalo/shared';
import { textEmailContent } from '../services/ai-content';
import { getOrCreateTag } from '../services/contacts';
import { HttpError } from '../util';
import {
  addCampaignEmail,
  createBroadcast,
  createCampaign,
  getBroadcast,
  getCampaign,
  scheduleBroadcast,
  sendBroadcastTest,
  unscheduleBroadcast,
  updateBroadcast,
  updateCampaignEmail,
} from './emails';

interface V1Helpers {
  need: (scope: OAuthScope) => (req: Request, res: Response, next: NextFunction) => void;
  grant: (req: Request) => { userId: number; scopes: OAuthScope[] };
}

const textFields = {
  preheader: z.string().trim().max(150).optional(),
  paragraphs: z.array(z.string().max(5000)).min(1).max(50).optional(),
  button_label: z.string().trim().min(1).max(60).optional(),
  button_url: z
    .string()
    .trim()
    .max(500)
    .regex(/^https?:\/\/[^\s<>"']+$/i, 'Lien invalide (http:// ou https://)')
    .optional(),
};
type TextFields = { preheader?: string; paragraphs?: string[]; button_label?: string; button_url?: string };

/** Email content from the text format; undefined when no paragraphs are given (content unchanged). */
function contentFrom(t: TextFields) {
  if (!!t.button_label !== !!t.button_url) throw new HttpError(400, 'Le bouton demande button_label et button_url');
  if (!t.paragraphs) {
    if (t.preheader !== undefined || t.button_label) throw new HttpError(400, 'preheader et bouton s’envoient avec paragraphs (le contenu est remplacé en entier)');
    return undefined;
  }
  if (!t.paragraphs.some((p) => p.trim())) throw new HttpError(400, 'Au moins un paragraphe non vide');
  return textEmailContent({ preheader: t.preheader, paragraphs: t.paragraphs, button: t.button_label ? { label: t.button_label, url: t.button_url! } : undefined });
}

const audience = { tag_id: z.number().int().positive().nullable().optional(), segment_id: z.number().int().positive().nullable().optional() };
const newsletterSchema = z.object({ subject: z.string().trim().min(1).max(250), ...textFields, ...audience });
const newsletterPatchSchema = z.object({ subject: z.string().trim().min(1).max(250).optional(), ...textFields, ...audience });
const tagName = z.string().trim().min(1).max(60);
const campaignSchema = z.object({ name: z.string().trim().min(1).max(120), trigger_tag: tagName.optional(), stop_tag: tagName.optional() });
const delayDays = z.number().int().min(0).max(3650);
const campaignEmailSchema = z.object({
  subject: z.string().trim().min(1).max(250),
  delay_days: delayDays,
  ...textFields,
  apply_to_existing: z.boolean().optional(),
});
const campaignEmailPatchSchema = z.object({ subject: z.string().trim().min(1).max(250).optional(), delay_days: delayDays.optional(), ...textFields });

export function mountV1Emails(r: Router, { need, grant }: V1Helpers) {
  // ----- newsletters -----

  r.get('/broadcasts/:id', need('emails:read'), async (req, res) => {
    res.json(await getBroadcast(grant(req).userId, req.params.id));
  });

  r.post('/broadcasts', need('emails:write'), async (req, res) => {
    const { userId } = grant(req);
    const { subject, tag_id, segment_id, ...text } = newsletterSchema.parse(req.body);
    if (!text.paragraphs) throw new HttpError(400, 'paragraphs est requis');
    const created = await createBroadcast(userId, { subject, content: contentFrom(text) });
    const out = tag_id || segment_id ? await updateBroadcast(userId, created.id, { tag_id, segment_id }) : created;
    res.status(201).json(out);
  });

  r.patch('/broadcasts/:id', need('emails:write'), async (req, res) => {
    const { subject, tag_id, segment_id, ...text } = newsletterPatchSchema.parse(req.body);
    res.json(await updateBroadcast(grant(req).userId, req.params.id, { subject, content: contentFrom(text), tag_id, segment_id }));
  });

  r.post('/broadcasts/:id/schedule', need('emails:write'), async (req, res) => {
    res.json(await scheduleBroadcast(grant(req).userId, req.params.id, req.body));
  });

  r.post('/broadcasts/:id/unschedule', need('emails:write'), async (req, res) => {
    res.json(await unscheduleBroadcast(grant(req).userId, req.params.id));
  });

  r.post('/broadcasts/:id/test', need('emails:write'), async (req, res) => {
    res.json(await sendBroadcastTest(grant(req).userId, req.params.id, req.body));
  });

  // ----- campaigns -----

  r.get('/campaigns/:id', need('emails:read'), async (req, res) => {
    res.json(await getCampaign(grant(req).userId, req.params.id));
  });

  r.post('/campaigns', need('emails:write'), async (req, res) => {
    const { userId } = grant(req);
    const body = campaignSchema.parse(req.body);
    const tagId = async (name?: string) => (name ? (await getOrCreateTag(userId, name)).id : null);
    res.status(201).json(await createCampaign(userId, { name: body.name, trigger_tag_id: await tagId(body.trigger_tag), stop_tag_id: await tagId(body.stop_tag) }));
  });

  r.post('/campaigns/:id/emails', need('emails:write'), async (req, res) => {
    const { subject, delay_days, apply_to_existing, ...text } = campaignEmailSchema.parse(req.body);
    if (!text.paragraphs) throw new HttpError(400, 'paragraphs est requis');
    res.status(201).json(await addCampaignEmail(grant(req).userId, req.params.id, { subject, delay_days, apply_to_existing, content: contentFrom(text) }));
  });

  r.patch('/campaign-emails/:id', need('emails:write'), async (req, res) => {
    const { subject, delay_days, ...text } = campaignEmailPatchSchema.parse(req.body);
    res.json(await updateCampaignEmail(grant(req).userId, req.params.id, { subject, delay_days, content: contentFrom(text) }));
  });
}

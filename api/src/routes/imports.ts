// Migration from another tool: contact import jobs (systeme.io API, CSV exports) and page import by URL.
// The heavy work is done by the worker (services/imports.ts); these routes only analyze, preview, queue and report.
import { Router, type Response } from 'express';
import { z } from 'zod';
import { CUSTOM_FIELD_KEY_RE, IMPORT_TARGETS, type ImportAnalysis, type ImportColumnMapping, type ImportTarget } from '@scalo/shared';
import { db, type Db } from '../db';
import { createField, keyFromLabel } from './crm';
import { fieldDefMap, listFieldDefs } from '../services/fields';
import { csvColumns, csvRecords, parseCsv, presetLabel, sioAnalysis, sioRecord, suggestCsvMapping } from '../services/import-sources';
import { cancelImportJob, createImportJob, jobQuery, MAX_ACTIVE_JOBS, previewRecords, toImportJob } from '../services/imports';
import { fetchPublicPage, htmlToBlocks } from '../services/page-import';
import { enforce } from '../services/ratelimit';
import { listSioContacts, listSioFields, listSioTags, SioError } from '../services/systeme-io';
import { HttpError, notFound, paramId, uid } from '../util';

export const importsRouter = Router();

export const MAX_IMPORT_ROWS = 200_000;
const csvSchema = z.string().min(1, 'Le fichier CSV est vide').max(5_000_000, 'Fichier trop volumineux (5 Mo maximum) : découpez-le en plusieurs fichiers');
const apiKeySchema = z
  .string()
  .trim()
  .min(8, 'Clé API trop courte')
  .max(500)
  .regex(/^[\x21-\x7e]+$/, 'Clé API invalide');

const mappingSchema = z
  .array(
    z.object({
      column: z.string().min(1).max(200),
      target: z.enum(IMPORT_TARGETS),
      field_key: z.string().regex(CUSTOM_FIELD_KEY_RE).optional(),
      create: z.object({ label: z.string().trim().min(1).max(80), type: z.enum(['text', 'number', 'date', 'checkbox']) }).optional(),
    }),
  )
  .min(1)
  .max(300);

const optionsSchema = z.object({
  keep_existing: z.boolean().optional().default(false),
  trigger: z.boolean().optional().default(false),
  tag: z.string().trim().max(60).nullable().optional(),
  consent: z.boolean().optional().default(false),
});

const sourceSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('csv'), csv: csvSchema, file_name: z.string().trim().max(150).optional() }),
  z.object({ source: z.literal('systeme_io'), api_key: apiKeySchema }),
]);

const SINGLE: ImportTarget[] = ['email', 'first_name', 'last_name', 'phone', 'created_at', 'status'];

/** Structural checks of a mapping (before anything is created). */
function checkMapping(mapping: ImportColumnMapping[], columns: Set<string> | null) {
  const count = (t: ImportTarget) => mapping.filter((m) => m.target === t).length;
  if (count('email') === 0) throw new HttpError(400, 'Indiquez la colonne qui contient l’adresse email');
  for (const t of SINGLE) if (count(t) > 1) throw new HttpError(400, 'Une même information ne peut venir que d’une seule colonne (email, prénom, nom, téléphone, date, statut)');
  const keys = new Set<string>();
  for (const m of mapping) {
    if (columns && !columns.has(m.column)) throw new HttpError(400, `Colonne inconnue : « ${m.column.slice(0, 60)} »`);
    if (m.target !== 'field') continue;
    if (!m.field_key && !m.create) throw new HttpError(400, `Choisissez un champ pour la colonne « ${m.column.slice(0, 60)} »`);
    const k = m.field_key ?? keyFromLabel(m.create!.label);
    if (keys.has(k)) throw new HttpError(400, 'Deux colonnes ne peuvent pas alimenter le même champ personnalisé');
    keys.add(k);
  }
}

/** Creates the custom fields the user confirmed in the mapping step; every `field` entry ends up with a `field_key`. */
async function resolveMapping(userId: number, mapping: ImportColumnMapping[], ex: Db): Promise<ImportColumnMapping[]> {
  const defs = await fieldDefMap(userId, ex);
  const out: ImportColumnMapping[] = [];
  for (const m of mapping) {
    if (m.target !== 'field') {
      out.push({ column: m.column, target: m.target });
      continue;
    }
    if (m.field_key) {
      if (!defs.has(m.field_key)) throw new HttpError(404, `Champ personnalisé introuvable : « ${m.field_key} »`);
      out.push({ column: m.column, target: 'field', field_key: m.field_key });
      continue;
    }
    const key = keyFromLabel(m.create!.label);
    const existing = defs.get(key);
    if (existing) {
      out.push({ column: m.column, target: 'field', field_key: existing.key });
      continue;
    }
    const created = await createField(userId, { label: m.create!.label, type: m.create!.type, key }, ex);
    defs.set(created.key, created);
    out.push({ column: m.column, target: 'field', field_key: created.key });
  }
  return out;
}

function sioHttpError(res: Response, e: unknown): never {
  if (e instanceof SioError) {
    if (e.kind === 'auth') throw new HttpError(400, e.message);
    if (e.kind === 'rate_limit') {
      res.setHeader('Retry-After', String(Math.ceil((e.retryAfterMs ?? 10_000) / 1000)));
      throw new HttpError(429, 'systeme.io limite le nombre d’appels : réessayez dans un instant.');
    }
    throw new HttpError(502, e.message);
  }
  throw e;
}

function loadCsv(text: string) {
  const csv = parseCsv(text);
  if (!csv.headers.length || !csv.rows.length) throw new HttpError(400, 'Le fichier CSV est vide (une ligne d’en-tête et au moins un contact sont attendus)');
  if (csv.rows.length > MAX_IMPORT_ROWS) throw new HttpError(400, `${MAX_IMPORT_ROWS.toLocaleString('fr-FR')} lignes maximum par fichier`);
  if (csv.columns.length > 300) throw new HttpError(400, 'Trop de colonnes (300 maximum)');
  return csv;
}

// ---------- analyze ----------

importsRouter.post('/imports/csv/analyze', async (req, res) => {
  const userId = uid(req);
  const { csv: text } = z.object({ csv: csvSchema }).parse(req.body);
  const csv = loadCsv(text);
  const { preset, mapping } = suggestCsvMapping(csv.columns, csv.headers, await listFieldDefs(userId));
  const out: ImportAnalysis = { source: 'csv', preset, preset_label: presetLabel(preset), columns: csvColumns(csv), mapping, rows: csv.rows.length };
  res.json(out);
});

/** Checks the API key and reads a first page: columns (custom fields of the account), samples, suggested mapping. */
importsRouter.post('/imports/systeme-io/connect', async (req, res) => {
  const userId = uid(req);
  const { api_key } = z.object({ api_key: apiKeySchema }).parse(req.body);
  await enforce(res, [[`sio-connect:${userId}`, { max: 20, windowMs: 10 * 60_000 }]]);
  try {
    const page = await listSioContacts(api_key, { limit: 50 });
    // optional calls: the import only needs the contacts
    const [labels, tags] = await Promise.all([listSioFields(api_key).catch(() => ({})), listSioTags(api_key, 2).catch(() => [] as string[])]);
    const { columns, mapping } = sioAnalysis(page.items, labels, await listFieldDefs(userId));
    const out: ImportAnalysis & { tags: string[]; has_more: boolean } = {
      source: 'systeme_io', preset: 'systeme_io', preset_label: presetLabel('systeme_io'), columns, mapping, rows: page.hasMore ? null : page.items.length,
      tags: tags.slice(0, 200), has_more: page.hasMore,
    };
    res.json(out);
  } catch (e) {
    sioHttpError(res, e);
  }
});

// ---------- preview ----------

importsRouter.post('/imports/preview', async (req, res) => {
  const userId = uid(req);
  const src = sourceSchema.parse(req.body);
  const mapping = mappingSchema.parse(req.body?.mapping) as ImportColumnMapping[];
  if (src.source === 'csv') {
    const csv = loadCsv(src.csv);
    checkMapping(mapping, new Set(csv.columns));
    res.json(await previewRecords(userId, csvRecords(csv), mapping, false));
    return;
  }
  checkMapping(mapping, null);
  await enforce(res, [[`sio-connect:${userId}`, { max: 20, windowMs: 10 * 60_000 }]]);
  try {
    const page = await listSioContacts(src.api_key, { limit: 50 });
    res.json(await previewRecords(userId, page.items.map((c, i) => sioRecord(c, i + 1)), mapping, page.hasMore));
  } catch (e) {
    sioHttpError(res, e);
  }
});

// ---------- jobs ----------

importsRouter.post('/imports', async (req, res) => {
  const userId = uid(req);
  const src = sourceSchema.parse(req.body);
  const mapping = mappingSchema.parse(req.body?.mapping) as ImportColumnMapping[];
  const options = optionsSchema.parse(req.body?.options ?? {});
  if (!options.consent) throw new HttpError(400, 'Vous devez attester que ces contacts ont accepté de recevoir vos emails');
  let total: number | null = null;
  let label = 'systeme.io (API)';
  if (src.source === 'csv') {
    const csv = loadCsv(src.csv);
    checkMapping(mapping, new Set(csv.columns));
    total = csv.rows.length;
    label = src.file_name || 'Fichier CSV';
  } else checkMapping(mapping, null);
  const job = await db.transaction().execute(async (trx) => {
    const active = await trx
      .selectFrom('import_jobs')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('user_id', '=', userId)
      .where('status', 'in', ['pending', 'running'])
      .executeTakeFirstOrThrow();
    if (active.n >= MAX_ACTIVE_JOBS) throw new HttpError(409, `${MAX_ACTIVE_JOBS} imports sont déjà en cours : attendez la fin de l’un d’eux`);
    return createImportJob(
      userId,
      {
        source: src.source,
        label,
        options: { keep_existing: options.keep_existing, trigger: options.trigger, tag: options.tag || null, consent: true },
        mapping: await resolveMapping(userId, mapping, trx),
        payload: src.source === 'csv' ? src.csv : null,
        apiKey: src.source === 'systeme_io' ? src.api_key : null,
        total,
      },
      trx,
    );
  });
  res.status(201).json(toImportJob(job));
});

importsRouter.get('/imports', async (req, res) => {
  const rows = await jobQuery(uid(req)).orderBy('id', 'desc').limit(30).execute();
  res.json(rows.map(toImportJob));
});

const ownedJob = async (userId: number, raw: unknown) => {
  const row = await jobQuery(userId).where('id', '=', paramId(raw, 'Import')).executeTakeFirst();
  if (!row) throw notFound('Import');
  return row;
};

importsRouter.get('/imports/:id', async (req, res) => {
  res.json(toImportJob(await ownedJob(uid(req), req.params.id)));
});

importsRouter.post('/imports/:id/cancel', async (req, res) => {
  const userId = uid(req);
  const job = await ownedJob(userId, req.params.id);
  if (!(await cancelImportJob(userId, job.id))) throw new HttpError(409, 'Cet import est déjà terminé');
  res.json(toImportJob(await ownedJob(userId, job.id)));
});

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // avoid spreadsheet formula injection
  return /[",;\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Error journal of a job (rejected lines and ignored values). */
importsRouter.get('/imports/:id/errors.csv', async (req, res) => {
  const job = await ownedJob(uid(req), req.params.id);
  const rows = await db.selectFrom('import_job_errors').select(['line', 'email', 'level', 'message']).where('job_id', '=', job.id).orderBy('id').execute();
  const lines = [['ligne', 'email', 'niveau', 'message'].join(',')];
  for (const r of rows) lines.push([r.line, r.email, r.level === 'error' ? 'erreur' : 'avertissement', r.message].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="import-${job.id}-erreurs.csv"`);
  res.send('﻿' + lines.join('\n') + '\n');
});

// ---------- page import by URL ----------

importsRouter.post('/imports/page', async (req, res) => {
  const userId = uid(req);
  const body = z.object({ url: z.string().trim().min(1).max(2000), consent: z.boolean().optional().default(false) }).parse(req.body);
  if (!body.consent) throw new HttpError(400, 'Vous devez attester que cette page vous appartient');
  await enforce(res, [[`page-import:${userId}`, { max: 20, windowMs: 10 * 60_000 }]]);
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(body.url) ? body.url : `https://${body.url}`;
  const page = await fetchPublicPage(raw);
  const result = htmlToBlocks(page.html, page.url);
  if (!result.content.blocks.length) {
    throw new HttpError(422, 'Aucun contenu lisible trouvé sur cette page (elle est peut-être affichée uniquement par JavaScript). Recréez-la à partir d’un modèle.');
  }
  if (page.truncated) result.warnings.unshift('Page volumineuse : seul le début (2 Mo) a été analysé.');
  res.json({ ...result, url: page.url, title: result.title || new URL(page.url).hostname });
});

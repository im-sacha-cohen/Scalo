// Account data: GDPR export (ZIP archive), deletion of all the data (the account stays, empty), deletion of the account.
//
// Deletions (resetAccountData / deleteAccount):
// 1. the sending queue of the account is paused, then we wait until no email of the account is being delivered by a
//    live worker (an email already handed to the SMTP server cannot be recalled; one claimed afterwards is given back
//    to the queue by the worker, which checks the pause before every email);
// 2. ONE transaction: the `users` row is locked first (FOR UPDATE: every insert that references the account — a form
//    submission, a scheduled newsletter, an import batch… — waits for us, then fails on its foreign key, or on the guard
//    of its claim for the automation runs and import jobs, deleted here), then the data is deleted. All or nothing;
// 3. after the commit only: files of the media library and of the lessons are removed from the disk.
// Logged on the server with the account id and counters only (no personal data).
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'kysely';
import type { AccountDataSummary } from '@scalo/shared';
import { db, nowIso, type Db } from '../db';
import { UPLOAD_DIR } from '../routes/uploads';
import { contactsCsv } from '../routes/contacts';
import { getSettingsRow, resetTransport } from './email';
import { listFieldDefs } from './fields';
import { createZip, type ZipEntry } from './zip';
import { HttpError } from '../util';

// ---------- files on disk ----------

const mediaDir = (userId: number) => path.join(UPLOAD_DIR, String(userId));
const lessonFilesDir = (userId: number) => path.join(UPLOAD_DIR, '_courses', String(userId));

function listDir(dir: string): { name: string; size: number; mtime: Date }[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => {
        const st = fs.statSync(path.join(dir, d.name));
        return { name: d.name, size: st.size, mtime: st.mtime };
      });
  } catch {
    return [];
  }
}

function removeAccountFiles(userId: number) {
  if (!Number.isSafeInteger(userId) || userId <= 0) return;
  for (const dir of [mediaDir(userId), lessonFilesDir(userId)]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error(`[account] compte ${userId} : fichiers non supprimés (${(e as Error).message})`);
    }
  }
}

// ---------- summary ----------

export async function accountSummary(userId: number): Promise<AccountDataSummary> {
  const n = (table: string, where = sql`user_id = ${userId}`) => sql<number>`(SELECT count(*) FROM ${sql.table(table)} WHERE ${where})`;
  const { rows } = await sql<Omit<AccountDataSummary['counts'], 'media_files' | 'files_bytes'> & { email: string; stripe: boolean; active_subscriptions: number }>`
    SELECT
      (SELECT email FROM users WHERE id = ${userId}) AS email,
      ${n('contacts')} AS contacts,
      ${n('tags')} AS tags,
      ${n('custom_fields')} AS custom_fields,
      ${n('segments')} AS segments,
      ${n('funnels')} AS funnels,
      (SELECT count(*) FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE f.user_id = ${userId}) AS steps,
      ${n('custom_domains')} AS domains,
      ${n('broadcasts')} AS broadcasts,
      ${n('campaigns')} AS campaigns,
      ${n('email_sends', sql`user_id = ${userId} AND status IN ('pending', 'sending')`)} AS queued_emails,
      ${n('automations')} AS automations,
      ${n('automation_runs', sql`user_id = ${userId} AND status IN ('pending', 'waiting', 'running')`)} AS active_runs,
      ${n('import_jobs')} AS imports,
      ${n('products')} AS products,
      ${n('orders')} AS orders,
      ${n('courses')} AS courses,
      (SELECT count(*) FROM course_lessons l JOIN courses c ON c.id = l.course_id WHERE c.user_id = ${userId}) AS lessons,
      ${n('course_enrollments')} + (SELECT count(*) FROM lesson_progress p JOIN courses c ON c.id = p.course_id WHERE c.user_id = ${userId}) AS students,
      ${n('affiliates')} AS affiliates,
      ${n('course_files')} AS lesson_files,
      ${n('account_members', sql`account_id = ${userId}`)} AS team_members,
      ${n('account_invitations', sql`account_id = ${userId} AND accepted_at IS NULL`)} AS invitations,
      ${n('oauth_clients')} AS oauth_apps,
      EXISTS (SELECT 1 FROM payment_settings WHERE user_id = ${userId} AND stripe_secret_key IS NOT NULL) AS stripe,
      ${n('orders', sql`user_id = ${userId} AND subscription_status IN ('active', 'past_due')`)} AS active_subscriptions
  `.execute(db);
  const r = rows[0];
  if (!r?.email) throw new HttpError(404, 'Compte introuvable');
  const media = listDir(mediaDir(userId));
  const lessonBytes = listDir(lessonFilesDir(userId)).reduce((s, f) => s + f.size, 0);
  const { email, stripe, active_subscriptions, ...counts } = r;
  return {
    email,
    counts: { ...counts, media_files: media.length, files_bytes: media.reduce((s, f) => s + f.size, 0) + lessonBytes },
    stripe_connected: stripe,
    active_subscriptions,
  };
}

// ---------- export ----------

/** Beyond these volumes the archive is not built synchronously (413): CSV export of the contacts instead. */
export const EXPORT_LIMITS = { contacts: 100_000, events: 500_000, filesBytes: 100 * 1024 * 1024 };

const omit = <T extends object, K extends keyof T>(row: T, keys: K[]): Omit<T, K> => {
  const out = { ...row };
  for (const k of keys) delete out[k];
  return out;
};
const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const safeName = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').slice(0, 120) || 'fichier';

const README = (date: string, filesNote: string) => `Export des données de votre compte Scalo — ${date}

Format : fichiers JSON (UTF-8) et CSV, lisibles par tout tableur ou programme.

  compte.json                 compte, réglages (sans aucun mot de passe ni clé), espace membres, programme d’affiliation, équipe
  contacts.json               contacts avec leurs tags, champs personnalisés et événements (historique complet)
  contacts.csv                les mêmes contacts au format CSV (réimportable dans Scalo ou un autre outil)
  tags.json, champs-personnalises.json, segments.json
  tunnels.json                tunnels, étapes (contenu des pages), variantes A/B, domaines personnalisés
  emails.json                 newsletters et campagnes (objets et contenus)
  automatisations.json        automatisations (déclencheur, conditions, actions)
  ventes.json                 produits, offres, commandes, paiements et remboursements
  formations.json             formations, modules, leçons, accès et progression des élèves
  affiliation.json            affiliés, parrainages, commissions et paiements
  imports.json                historique des imports de contacts
  medias/, medias.json        images de votre médiathèque (et leur liste)
  formations/fichiers/        fichiers joints aux leçons
${filesNote}
Ne contient aucun secret : ni mot de passe, ni clé Stripe ou IA, ni secret de webhook, ni jeton.
Les coordonnées de paiement des affiliés (chiffrées) ne sont pas exportées.
Les dates sont en UTC (ISO 8601) ; les champs « Date et heure » aussi.
`;

/** Builds the export archive. Throws 413 when the account is too big for a synchronous export. */
export async function exportAccount(userId: number): Promise<{ zip: Buffer; filename: string }> {
  const counts = await sql<{ contacts: number; events: number }>`
    SELECT (SELECT count(*) FROM contacts WHERE user_id = ${userId}) AS contacts,
           (SELECT count(*) FROM contact_events WHERE user_id = ${userId}) AS events`.execute(db);
  const c = counts.rows[0];
  if (c.contacts > EXPORT_LIMITS.contacts || c.events > EXPORT_LIMITS.events) {
    throw new HttpError(
      413,
      `Compte trop volumineux pour un export immédiat (${c.contacts.toLocaleString('fr-FR')} contacts, ${c.events.toLocaleString('fr-FR')} événements). Exportez vos contacts en CSV depuis la page Contacts, ou demandez un export complet à l’administrateur de l’instance.`,
    );
  }
  const date = nowIso();
  const entries: ZipEntry[] = [];
  const add = (name: string, data: unknown) => entries.push({ name, data: typeof data === 'string' ? data : json(data) });

  // --- account, settings (no secret) ---
  const user = await db.selectFrom('users').select(['id', 'email', 'name', 'created_at']).where('id', '=', userId).executeTakeFirstOrThrow();
  const settings = await getSettingsRow(userId);
  const payment = await db.selectFrom('payment_settings').select(['mode', 'account_name', 'verified_at']).where('user_id', '=', userId).executeTakeFirst();
  const ai = await db.selectFrom('ai_settings').select(['updated_at']).where('user_id', '=', userId).executeTakeFirst();
  const memberArea = await db.selectFrom('member_areas').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const program = await db.selectFrom('affiliate_programs').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const onboarding = await db.selectFrom('account_onboarding').selectAll().where('user_id', '=', userId).executeTakeFirst();
  const apps = await db
    .selectFrom('oauth_clients')
    .select(['client_id', 'name', 'description', 'website', 'logo_url', 'type', 'redirect_uris', 'scopes', 'created_at', 'updated_at'])
    .where('user_id', '=', userId)
    .execute();
  const team = await db
    .selectFrom('account_members as m')
    .innerJoin('users as u', 'u.id', 'm.user_id')
    .select(['u.email', 'u.name', 'm.role', 'm.created_at'])
    .where('m.account_id', '=', userId)
    .execute();
  const invitations = await db
    .selectFrom('account_invitations')
    .select(['email', 'role', 'expires_at', 'accepted_at', 'created_at'])
    .where('account_id', '=', userId)
    .execute();
  add('compte.json', {
    format: 'scalo-account-export',
    version: 1,
    exported_at: date,
    account: user,
    settings: {
      sender_name: settings.sender_name,
      sender_email: settings.sender_email,
      company_address: settings.company_address,
      smtp_host: settings.smtp_host,
      smtp_port: settings.smtp_port,
      smtp_secure: settings.smtp_secure,
      rate_per_minute: settings.rate_per_minute,
      daily_limit: settings.daily_limit,
      double_optin_default: settings.double_optin_default,
      dkim_selectors: settings.dkim_selectors,
    },
    payments: payment ? { stripe_connected: true, ...payment } : { stripe_connected: false },
    ai: { own_key: !!ai },
    member_area: memberArea ? omit(memberArea, ['user_id']) : null,
    affiliate_program: program ? omit(program, ['user_id']) : null,
    onboarding: onboarding ? omit(onboarding, ['user_id']) : null,
    oauth_apps: apps,
    team: { members: team, invitations },
  });

  // --- contacts (tags, custom fields, events) ---
  const tags = await db.selectFrom('tags').select(['id', 'name', 'created_at']).where('user_id', '=', userId).orderBy('id').execute();
  const tagName = new Map(tags.map((t) => [t.id, t.name]));
  const contactRows = await db.selectFrom('contacts').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const contactTags = await db
    .selectFrom('contact_tags as ct')
    .innerJoin('contacts as c', 'c.id', 'ct.contact_id')
    .select(['ct.contact_id', 'ct.tag_id', 'ct.created_at'])
    .where('c.user_id', '=', userId)
    .execute();
  const events = await db
    .selectFrom('contact_events')
    .select(['contact_id', 'type', 'data', 'funnel_id', 'step_id', 'variant_id', 'attribution', 'created_at'])
    .where('user_id', '=', userId)
    .orderBy('contact_id')
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const tagsBy = new Map<number, { name: string; added_at: string }[]>();
  for (const t of contactTags) {
    const list = tagsBy.get(t.contact_id) ?? [];
    list.push({ name: tagName.get(t.tag_id) ?? '', added_at: t.created_at });
    tagsBy.set(t.contact_id, list);
  }
  const eventsBy = new Map<number, unknown[]>();
  for (const e of events) {
    const list = eventsBy.get(e.contact_id) ?? [];
    list.push(omit(e, ['contact_id']));
    eventsBy.set(e.contact_id, list);
  }
  add(
    'contacts.json',
    contactRows.map((r) => ({ ...omit(r, ['user_id']), tags: tagsBy.get(r.id) ?? [], events: eventsBy.get(r.id) ?? [] })),
  );
  add('contacts.csv', await contactsCsv(userId));
  add('tags.json', tags);
  add('champs-personnalises.json', await listFieldDefs(userId));
  add('segments.json', await db.selectFrom('segments').select(['id', 'name', 'filter', 'created_at', 'updated_at']).where('user_id', '=', userId).orderBy('id').execute());

  // --- funnels ---
  const funnels = await db.selectFrom('funnels').select(['id', 'name', 'slug', 'settings', 'created_at']).where('user_id', '=', userId).orderBy('id').execute();
  const funnelIds = funnels.map((f) => f.id);
  const steps = funnelIds.length
    ? await db
        .selectFrom('steps')
        .select(['id', 'funnel_id', 'name', 'slug', 'type', 'position', 'content', 'access', 'ab_status', 'ab_control_weight', 'ab_started_at', 'created_at'])
        .where('funnel_id', 'in', funnelIds)
        .orderBy('funnel_id')
        .orderBy('position')
        .execute()
    : [];
  const stepIds = steps.map((s) => s.id);
  const variants = stepIds.length ? await db.selectFrom('step_variants').selectAll().where('step_id', 'in', stepIds).orderBy('id').execute() : [];
  const domains = await db
    .selectFrom('custom_domains')
    .select(['id', 'funnel_id', 'domain', 'root_step_id', 'status', 'verified_at', 'created_at'])
    .where('user_id', '=', userId)
    .execute();
  add(
    'tunnels.json',
    funnels.map((f) => ({
      ...f,
      steps: steps
        .filter((s) => s.funnel_id === f.id)
        .map((s) => ({ ...omit(s, ['funnel_id']), variants: variants.filter((v) => v.step_id === s.id).map((v) => omit(v, ['step_id'])) })),
      domains: domains.filter((d) => d.funnel_id === f.id).map((d) => omit(d, ['funnel_id'])),
    })),
  );

  // --- emails ---
  const broadcasts = await db.selectFrom('broadcasts').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const campaigns = await db.selectFrom('campaigns').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const campaignEmails = campaigns.length
    ? await db.selectFrom('campaign_emails').selectAll().where('campaign_id', 'in', campaigns.map((x) => x.id)).orderBy('position').execute()
    : [];
  add('emails.json', {
    newsletters: broadcasts.map((b) => omit(b, ['user_id'])),
    campaigns: campaigns.map((x) => ({ ...omit(x, ['user_id']), emails: campaignEmails.filter((e) => e.campaign_id === x.id).map((e) => omit(e, ['campaign_id'])) })),
  });

  // --- automations (no webhook token, no signing secret) ---
  add(
    'automatisations.json',
    await db
      .selectFrom('automations')
      .select(['id', 'name', 'enabled', 'trigger_type', 'trigger', 'conditions', 'actions', 'run_once', 'created_at', 'updated_at'])
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute(),
  );

  // --- sales ---
  const products = await db.selectFrom('products').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const prices = await db.selectFrom('product_prices').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const orders = await db.selectFrom('orders').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  const items = orders.length ? await db.selectFrom('order_items').selectAll().where('order_id', 'in', orders.map((o) => o.id)).orderBy('id').execute() : [];
  const transactions = await db.selectFrom('order_transactions').selectAll().where('user_id', '=', userId).orderBy('id').execute();
  add('ventes.json', {
    products: products.map((p) => ({ ...omit(p, ['user_id']), prices: prices.filter((x) => x.product_id === p.id).map((x) => omit(x, ['user_id', 'product_id'])) })),
    orders: orders.map((o) => ({
      ...omit(o, ['user_id']),
      items: items.filter((i) => i.order_id === o.id).map((i) => omit(i, ['order_id'])),
      transactions: transactions.filter((t) => t.order_id === o.id).map((t) => omit(t, ['user_id', 'order_id'])),
    })),
  });

  // --- courses ---
  const courses = await db.selectFrom('courses').selectAll().where('user_id', '=', userId).orderBy('position').execute();
  const courseIds = courses.map((x) => x.id);
  const modules = courseIds.length ? await db.selectFrom('course_modules').selectAll().where('course_id', 'in', courseIds).orderBy('position').execute() : [];
  const lessons = courseIds.length ? await db.selectFrom('course_lessons').selectAll().where('course_id', 'in', courseIds).orderBy('position').execute() : [];
  const files = await db.selectFrom('course_files').select(['id', 'lesson_id', 'name', 'stored', 'size', 'created_at']).where('user_id', '=', userId).orderBy('id').execute();
  const enrollments = await db.selectFrom('course_enrollments').select(['course_id', 'contact_id', 'access_at', 'expires_at', 'created_at']).where('user_id', '=', userId).execute();
  const progress = courseIds.length ? await db.selectFrom('lesson_progress').selectAll().where('course_id', 'in', courseIds).execute() : [];
  const completions = courseIds.length ? await db.selectFrom('course_completions').selectAll().where('course_id', 'in', courseIds).execute() : [];

  // --- files (media library, lesson files): included up to EXPORT_LIMITS.filesBytes ---
  let budget = EXPORT_LIMITS.filesBytes;
  const skipped: string[] = [];
  const media = listDir(mediaDir(userId)).sort((a, b) => a.name.localeCompare(b.name));
  const mediaList: { name: string; size: number; included: boolean }[] = [];
  for (const m of media) {
    const ok = m.size <= budget;
    if (ok) {
      budget -= m.size;
      entries.push({ name: `medias/${safeName(m.name)}`, data: fs.readFileSync(path.join(mediaDir(userId), m.name)), store: true, mtime: m.mtime });
    } else skipped.push(`medias/${m.name}`);
    mediaList.push({ name: m.name, size: m.size, included: ok });
  }
  const fileList = files.map((f) => {
    const name = `formations/fichiers/${f.id}-${safeName(f.name)}`;
    let included = false;
    if (f.size <= budget) {
      try {
        entries.push({ name, data: fs.readFileSync(path.join(lessonFilesDir(userId), f.stored)) });
        budget -= f.size;
        included = true;
      } catch {
        /* missing on disk */
      }
    }
    if (!included) skipped.push(name);
    return { ...omit(f, ['stored']), path: included ? name : null };
  });
  add('formations.json', {
    courses: courses.map((x) => ({
      ...omit(x, ['user_id']),
      modules: modules.filter((m) => m.course_id === x.id).map((m) => omit(m, ['course_id'])),
      lessons: lessons.filter((l) => l.course_id === x.id).map((l) => ({ ...omit(l, ['course_id']), files: fileList.filter((f) => f.lesson_id === l.id) })),
      enrollments: enrollments.filter((e) => e.course_id === x.id),
      progress: progress.filter((p) => p.course_id === x.id),
      completions: completions.filter((p) => p.course_id === x.id),
    })),
  });
  add('medias.json', mediaList);

  // --- affiliation (payout details are encrypted personal data of the affiliates: not exported) ---
  add('affiliation.json', {
    affiliates: (await db.selectFrom('affiliates').selectAll().where('user_id', '=', userId).orderBy('id').execute()).map((a) => omit(a, ['user_id', 'payout_details_enc'])),
    commission_rules: (await db.selectFrom('affiliate_commission_rules').selectAll().where('user_id', '=', userId).execute()).map((r) => omit(r, ['user_id'])),
    referrals: (await db.selectFrom('affiliate_referrals').selectAll().where('user_id', '=', userId).orderBy('id').execute()).map((r) => omit(r, ['user_id'])),
    commissions: (await db.selectFrom('affiliate_commissions').selectAll().where('user_id', '=', userId).orderBy('id').execute()).map((r) => omit(r, ['user_id'])),
    payouts: (await db.selectFrom('affiliate_payouts').selectAll().where('user_id', '=', userId).orderBy('id').execute()).map((r) => omit(r, ['user_id'])),
  });
  add(
    'imports.json',
    await db
      .selectFrom('import_jobs')
      .select(['id', 'source', 'status', 'label', 'options', 'mapping', 'total', 'processed', 'created_count', 'updated_count', 'skipped_count', 'error_count', 'warning_count', 'error', 'created_at', 'finished_at'])
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute(),
  );

  const filesNote = skipped.length
    ? `\n${skipped.length} fichier(s) non inclus (archive limitée à ${Math.round(EXPORT_LIMITS.filesBytes / 1024 / 1024)} Mo de fichiers) : téléchargez-les depuis la médiathèque ou la leçon.\n`
    : '';
  entries.unshift({ name: 'LISEZMOI.txt', data: README(date.slice(0, 10), filesNote) });
  return { zip: createZip(entries), filename: `scalo-export-${date.slice(0, 10)}.zip` };
}

// ---------- deletions ----------

/** Tables with a `user_id` column that a data reset keeps (account settings); everything else of the account goes. */
export const KEPT_ON_RESET = [
  'settings', // sender, address, SMTP, sending rate
  'payment_settings', // Stripe connection
  'ai_settings', // Claude API key
  'oauth_clients', 'oauth_codes', 'oauth_tokens', 'oauth_consents', // developer apps and connected applications
  'member_areas', // name / address of the members area
  'affiliate_programs', // affiliate program settings
  'account_onboarding',
];

const PAUSE_REASON = 'Suppression des données du compte en cours';

async function pauseSending(userId: number) {
  const before = await getSettingsRow(userId);
  await db.updateTable('settings').set({ sending_paused: true, paused_reason: PAUSE_REASON }).where('user_id', '=', userId).execute();
  return { sending_paused: before.sending_paused, paused_reason: before.paused_reason };
}

/** Waits until no email of the account is being delivered by a live worker instance. */
async function waitForDeliveries(userId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*) AS n FROM email_sends s
       WHERE s.user_id = ${userId} AND s.status = 'sending'
         AND EXISTS (SELECT 1 FROM worker_instances w WHERE w.id = s.claimed_by AND w.heartbeat_at > now() - interval '30 seconds')`.execute(db);
    if (!rows[0].n) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export interface DeletionOptions {
  /** How long to wait for the emails being delivered (tests use a short delay). */
  waitMs?: number;
}

const BUSY = 'Des emails de ce compte sont en cours d’envoi : réessayez dans une minute.';

/** Locks the account row (see the header) and raises the statement timeout of this transaction. */
async function lockAccount(trx: Db, userId: number) {
  await sql`SET LOCAL statement_timeout = '120s'`.execute(trx);
  const u = await trx.selectFrom('users').select('id').where('id', '=', userId).forUpdate().executeTakeFirst();
  if (!u) throw new HttpError(404, 'Compte introuvable');
}

/** Deletes every piece of data of the account in `trx` (not its settings: see KEPT_ON_RESET). */
async function deleteData(trx: Db, userId: number) {
  const del = (table: 'email_sends' | 'automation_runs' | 'automations' | 'import_jobs' | 'affiliate_commissions' | 'affiliate_payouts' | 'affiliate_referrals' | 'affiliate_clicks' | 'affiliate_commission_rules' | 'affiliates' | 'order_transactions' | 'orders' | 'stripe_events' | 'product_prices' | 'products' | 'course_enrollments' | 'course_files' | 'courses' | 'member_login_tokens' | 'pending_optins' | 'contact_events' | 'contacts' | 'broadcasts' | 'campaigns' | 'segments' | 'custom_fields' | 'tags' | 'custom_domains' | 'page_views' | 'funnels' | 'ai_generations') =>
    trx.deleteFrom(table).where('user_id', '=', userId).execute();
  // order: children first where the foreign key is SET NULL (orders → contacts, commissions → orders…)
  await del('email_sends');
  await del('automation_runs');
  await del('automations');
  await del('import_jobs'); // + import_job_errors (cascade)
  await del('affiliate_commissions');
  await del('affiliate_payouts');
  await del('affiliate_referrals');
  await del('affiliate_clicks');
  await del('affiliate_commission_rules');
  await del('affiliates');
  await del('order_transactions');
  await del('orders'); // + order_items
  await del('stripe_events');
  await del('product_prices');
  await del('products');
  await del('course_enrollments');
  await del('course_files');
  await del('courses'); // + modules, lessons, lesson_progress, course_completions
  await del('member_login_tokens');
  await del('pending_optins');
  await del('contact_events');
  await del('contacts'); // + contact_tags, campaign_subscriptions
  await del('broadcasts');
  await del('campaigns'); // + campaign_emails
  await del('segments');
  await del('custom_fields');
  await del('tags');
  await del('custom_domains');
  await del('page_views');
  await del('funnels'); // + steps, step_variants
  await del('ai_generations');
}

type Summary = AccountDataSummary['counts'];
const logLine = (c: Summary) =>
  `${c.contacts} contacts, ${c.funnels} tunnels, ${c.broadcasts + c.campaigns} emails/campagnes, ${c.automations} automatisations, ${c.orders} commandes, ${c.courses} formations, ${c.media_files + c.lesson_files} fichiers`;

/** Deletes all the data of the account; the account, its settings and its team stay (as just after sign-up). */
export async function resetAccountData(userId: number, opts: DeletionOptions = {}): Promise<Summary> {
  const { counts } = await accountSummary(userId);
  const previous = await pauseSending(userId);
  try {
    if (!(await waitForDeliveries(userId, opts.waitMs ?? 20_000))) throw new HttpError(409, BUSY);
    await db.transaction().execute(async (trx) => {
      await lockAccount(trx, userId);
      await deleteData(trx, userId);
      await trx.updateTable('settings').set(previous).where('user_id', '=', userId).execute();
    });
  } catch (e) {
    // nothing was deleted: the queue goes back to its previous state
    await db.updateTable('settings').set(previous).where('user_id', '=', userId).where('paused_reason', '=', PAUSE_REASON).execute().catch(() => undefined);
    throw e;
  }
  removeAccountFiles(userId);
  resetTransport(userId);
  console.log(`[account] compte ${userId} : toutes les données ont été supprimées (${logLine(counts)})`);
  return counts;
}

/** Deletes the account: its data, its settings, its OAuth applications and tokens, its team members and invitations. */
export async function deleteAccount(userId: number, opts: DeletionOptions = {}): Promise<Summary> {
  const { counts } = await accountSummary(userId);
  const previous = await pauseSending(userId);
  try {
    if (!(await waitForDeliveries(userId, opts.waitMs ?? 20_000))) throw new HttpError(409, BUSY);
    await db.transaction().execute(async (trx) => {
      await lockAccount(trx, userId);
      await deleteData(trx, userId); // explicit order first (foreign keys SET NULL), then the cascades of `users`
      // Enterprise edition: a member's login only exists for his membership (see ee/api/src/team.ts)
      await trx
        .deleteFrom('users')
        .where('id', 'in', trx.selectFrom('account_members').select('user_id').where('account_id', '=', userId))
        .execute();
      await trx.deleteFrom('users').where('id', '=', userId).execute(); // settings, OAuth apps / tokens, invitations, audit log… (CASCADE)
    });
  } catch (e) {
    await db.updateTable('settings').set(previous).where('user_id', '=', userId).where('paused_reason', '=', PAUSE_REASON).execute().catch(() => undefined);
    throw e;
  }
  removeAccountFiles(userId);
  resetTransport(userId);
  console.log(`[account] compte ${userId} supprimé (${logLine(counts)}, ${counts.team_members} membre(s) d’équipe)`);
  return counts;
}

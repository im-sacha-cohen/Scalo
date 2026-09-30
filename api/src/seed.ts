// npm run seed            — creates the demo account (skipped if it already exists)
// npm run seed -- --reset   — empties every table first (refused when NODE_ENV=production)
import { env } from './env';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { DEFAULT_EMAIL_SETTINGS, uid as blockId, type Block, type PageContent } from '@scalo/shared';
import { checkDb, closeDb, db, truncateAll } from './db';
import { migrateToLatest } from './db/migrate';
import { addTag, getOrCreateTag, logEvent, upsertContact } from './services/contacts';
import { requestOptin } from './services/optin';
import { createFunnel } from './routes/funnels';
import { EmailWorker } from './worker';

const DEMO_EMAIL = 'demo@scalo.test';
const DAY = 86400_000;

// Deterministic PRNG so the demo looks the same on every fresh seed.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
const iso = (t: number) => new Date(t).toISOString();

type BlockInput = Block extends infer T ? (T extends Block ? Omit<T, 'id'> : never) : never;
const b = (x: BlockInput): Block => ({ id: blockId(), ...x }) as Block;
const email = (blocks: BlockInput[]): PageContent => ({ settings: { ...DEFAULT_EMAIL_SETTINGS }, blocks: blocks.map(b) });

async function main() {
  await checkDb();
  await migrateToLatest(db, { quiet: true });
  if (process.argv.includes('--reset')) {
    if (env.NODE_ENV === 'production') throw new Error('--reset est refusé quand NODE_ENV=production');
    await truncateAll();
    console.log('Base vidée (--reset).');
  }
  const existing = await db.selectFrom('users').select('id').where('email', '=', DEMO_EMAIL).executeTakeFirst();
  if (existing) {
    console.log(`Utilisateur démo déjà présent (${DEMO_EMAIL}) — seed ignoré.`);
    return;
  }
  const now = Date.now();
  const hash = await bcrypt.hash('demo1234', 10);

  const userId = await db.transaction().execute(async (trx) => {
    const { id: userId } = await trx
      .insertInto('users')
      .values({ email: DEMO_EMAIL, password_hash: hash, name: 'Camille Martin', created_at: iso(now - 40 * DAY) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('settings')
      .values({
        user_id: userId,
        sender_name: 'Camille de Business Facile',
        sender_email: DEMO_EMAIL,
        company_address: 'Business Facile SAS — 12 rue de la Paix, 75002 Paris, France',
      })
      .execute();

    const lead = await getOrCreateTag(userId, 'lead', trx);
    const client = await getOrCreateTag(userId, 'client', trx);
    const webinar = await getOrCreateTag(userId, 'webinar', trx);

    // ---- campaign (created first so that tagging leads enrolls them) ----
    const { id: campaignId } = await trx
      .insertInto('campaigns')
      .values({ user_id: userId, name: 'Séquence de bienvenue', trigger_tag_id: lead.id, created_at: iso(now - 35 * DAY) })
      .returning('id')
      .executeTakeFirstOrThrow();
    const campEmails: { subject: string; delay: number; content: PageContent }[] = [
      {
        subject: 'Bienvenue {{first_name}} ! Voici votre guide 🎁',
        delay: 0,
        content: email([
          { type: 'text', text: 'Bonjour {{first_name}},' },
          { type: 'text', text: 'Merci pour votre inscription ! Comme promis, voici votre guide **« Les 7 secrets pour doubler vos ventes en 30 jours »**.' },
          { type: 'button', label: 'Télécharger le guide', action: 'url', url: 'https://exemple.com/guide-7-secrets.pdf', style: { align: 'center' } },
          { type: 'text', text: 'Prenez 15 minutes pour le lire aujourd’hui : le secret n°3 à lui seul peut changer votre façon de vendre.' },
          { type: 'text', text: 'À très vite,\nCamille' },
        ]),
      },
      {
        subject: "L'erreur n°1 qui vous fait perdre des clients",
        delay: 1,
        content: email([
          { type: 'text', text: 'Bonjour {{first_name}},' },
          { type: 'text', text: 'Hier, je vous ai envoyé le guide. Aujourd’hui, je veux vous parler de l’erreur que je vois **le plus souvent** chez les entrepreneurs : parler de son produit au lieu de parler du problème de son client.' },
          { type: 'list', items: ['Identifiez la douleur principale de votre client', 'Reformulez-la avec ses propres mots', 'Présentez votre offre comme le pont vers la solution'], icon: 'number' },
          { type: 'text', text: 'Essayez dès aujourd’hui sur votre page de vente et dites-moi ce que ça change.' },
          { type: 'text', text: 'Camille' },
        ]),
      },
      {
        subject: '{{first_name}}, prêt(e) à passer à la vitesse supérieure ?',
        delay: 3,
        content: email([
          { type: 'text', text: 'Bonjour {{first_name}},' },
          { type: 'text', text: 'Si vous avez appliqué les conseils du guide, vous avez sûrement déjà vu les premiers résultats. Bravo !' },
          { type: 'text', text: 'Pour aller plus loin, j’ai créé **la formation complète** : 8 modules vidéo, une communauté privée et tous mes modèles prêts à l’emploi.' },
          { type: 'button', label: 'Découvrir la formation', action: 'url', url: 'https://exemple.com/formation', style: { align: 'center' } },
          { type: 'text', text: '*Garantie 30 jours satisfait ou remboursé.*', style: { align: 'center', color: '#64748b' } },
          { type: 'text', text: 'À bientôt,\nCamille' },
        ]),
      },
    ];
    await trx
      .insertInto('campaign_emails')
      .values(campEmails.map((e, i) => ({ campaign_id: campaignId, subject: e.subject, content: JSON.stringify(e.content), delay_days: e.delay, position: i })))
      .execute();
    // conditional email: only for contacts who registered to the webinar (skipped for the others)
    await trx
      .insertInto('campaign_emails')
      .values({
        campaign_id: campaignId,
        subject: '🎥 Le replay du webinaire est disponible',
        delay_days: 2,
        position: campEmails.length,
        condition: JSON.stringify({ type: 'has_tag', tag_id: webinar.id, action: 'skip' }),
        content: JSON.stringify(
          email([
            { type: 'text', text: 'Bonjour {{first_name}},' },
            { type: 'text', text: 'Merci d’avoir participé au webinaire ! Comme promis, voici le **replay complet** (disponible 7 jours).' },
            { type: 'button', label: 'Voir le replay', action: 'url', url: 'https://exemple.com/replay', style: { align: 'center' } },
            { type: 'text', text: 'Camille' },
          ]),
        ),
      })
      .execute();

    // ---- funnels ----
    const guideId = await createFunnel(userId, 'Guide gratuit', 'optin', iso(now - 35 * DAY), trx);
    const formationId = await createFunnel(userId, 'Formation', 'sales', iso(now - 33 * DAY), trx);
    const stepsOf = (fid: number) =>
      trx.selectFrom('steps').select(['id', 'name', 'position']).where('funnel_id', '=', fid).orderBy('position').execute();
    const funnels = [
      { id: guideId, name: 'Guide gratuit', steps: await stepsOf(guideId), weight: 0.65 },
      { id: formationId, name: 'Formation', steps: await stepsOf(formationId), weight: 0.35 },
    ];

    // ---- page views: per day, per funnel, a decreasing number of unique visitors per step ----
    const views: { user_id: number; funnel_id: number; step_id: number; visitor_id: string; created_at: string }[] = [];
    for (let d = 29; d >= 0; d--) {
      const dayStart = now - d * DAY - (now % DAY);
      for (const f of funnels) {
        let visitors = Math.round(randInt(18, 45) * f.weight * (1 + (29 - d) / 40));
        f.steps.forEach((s) => {
          for (let v = 0; v < visitors; v++) {
            const t = Math.min(now - 60_000, dayStart + randInt(0, DAY - 1));
            views.push({ user_id: userId, funnel_id: f.id, step_id: s.id, visitor_id: `seed-${f.id}-${d}-${v}`, created_at: iso(t) });
          }
          visitors = Math.round(visitors * (0.35 + rand() * 0.2));
        });
      }
    }

    for (let i = 0; i < views.length; i += 1000) await trx.insertInto('page_views').values(views.slice(i, i + 1000)).execute();

    // ---- contacts ----
    const firstNames = ['Julie', 'Thomas', 'Léa', 'Nicolas', 'Chloé', 'Maxime', 'Emma', 'Antoine', 'Manon', 'Lucas', 'Camille', 'Hugo', 'Sarah', 'Julien', 'Inès', 'Paul', 'Clara', 'Alexandre', 'Zoé', 'Mathieu'];
    const lastNames = ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier'];
    // reserved .test domains (RFC 2606): a demo account with a real SMTP server must never write to real mailboxes
    const domains = ['exemple.test', 'courriel.test', 'messagerie.test', 'boite.test', 'poste.test', 'mail.test'];
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

    for (let i = 0; i < 40; i++) {
      const fn = firstNames[i % firstNames.length];
      const ln = pick(lastNames);
      const addr = `${norm(fn)}.${norm(ln)}${i >= firstNames.length ? i : ''}@${pick(domains)}`;
      // skew towards recent days
      const daysAgo = Math.floor(Math.pow(rand(), 1.4) * 30);
      const createdAt = Math.min(now - 5 * 60_000, now - daysAgo * DAY + randInt(-6, 6) * 3600_000);
      const at = iso(createdAt);
      const { contact } = await upsertContact(
        userId,
        { email: addr, first_name: fn, last_name: ln, phone: rand() < 0.4 ? `06 ${randInt(10, 99)} ${randInt(10, 99)} ${randInt(10, 99)} ${randInt(10, 99)}` : null },
        { created_at: at },
        trx,
      );
      if (rand() < 0.85) {
        const f = rand() < 0.65 ? funnels[0] : funnels[1];
        await logEvent(userId, contact.id, 'optin', { funnel: f.name, step: f.steps[0].name }, { funnel_id: f.id, step_id: f.steps[0].id, created_at: at }, trx);
        await addTag(userId, contact.id, lead, at, trx); // → enrolls in "Séquence de bienvenue"
      }
      if (rand() < 0.25) await addTag(userId, contact.id, client, iso(Math.min(now - 60_000, createdAt + randInt(1, 4) * DAY)), trx);
      if (rand() < 0.3) await addTag(userId, contact.id, webinar, iso(Math.min(now - 60_000, createdAt + randInt(0, 2) * DAY)), trx);
      if (i === 7) await trx.updateTable('contacts').set({ unsubscribed: true }).where('id', '=', contact.id).execute();
    }

    // a visitor who has not clicked the double opt-in link yet
    {
      const at = iso(now - 2 * 3600_000);
      const { contact } = await upsertContact(userId, { email: 'louise.garnier@exemple.test', first_name: 'Louise', last_name: 'Garnier' }, { created_at: at, optin: 'pending' }, trx);
      const f = funnels[0];
      await logEvent(userId, contact.id, 'optin', { funnel: f.name, step: f.steps[0].name, double_optin: true }, { funnel_id: f.id, step_id: f.steps[0].id, created_at: at }, trx);
      await requestOptin({ userId, contact, tagName: 'lead', funnelId: f.id, stepId: f.steps[0].id }, trx);
    }

    // ---- broadcasts ----
    const sentAt = iso(now - 6 * DAY);
    const WEBINAR = '🎙️ Webinaire gratuit jeudi : 3 leviers pour vendre plus';
    const { id: broadcastId } = await trx
      .insertInto('broadcasts')
      .values({
        user_id: userId,
        subject: WEBINAR,
        tag_id: null,
        status: 'sent',
        sent_at: sentAt,
        created_at: iso(now - 7 * DAY),
        content: JSON.stringify(
          email([
            { type: 'heading', level: 2, text: 'Webinaire gratuit ce jeudi à 19h', style: { align: 'center' } },
            { type: 'text', text: 'Bonjour {{first_name}},' },
            { type: 'text', text: 'Ce jeudi, je vous présente en direct **les 3 leviers** que j’utilise pour augmenter mes ventes sans augmenter mon budget publicitaire.' },
            { type: 'list', items: ['Le levier « offre irrésistible »', 'Le levier « séquence email »', 'Le levier « page de remerciement »'], icon: 'check' },
            { type: 'button', label: 'Je réserve ma place', action: 'url', url: 'https://exemple.com/webinaire', style: { align: 'center' } },
            { type: 'text', text: 'Les places sont limitées à 100 participants.\nCamille' },
          ]),
        ),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const recipients = await trx
      .selectFrom('contacts')
      .select(['id', 'email'])
      .where('user_id', '=', userId)
      .where('unsubscribed', '=', false)
      .where('created_at', '<=', sentAt)
      .execute();
    if (recipients.length) {
      await trx
        .insertInto('email_sends')
        .values(
          recipients.map((r) => ({
            user_id: userId, contact_id: r.id, broadcast_id: broadcastId, to_email: r.email, subject: WEBINAR,
            status: 'pending' as const, send_at: sentAt, created_at: sentAt,
          })),
        )
        .execute();
    }

    await trx
      .insertInto('broadcasts')
      .values({
        user_id: userId,
        subject: 'Offre spéciale clients : -30 % sur la formation',
        tag_id: client.id,
        status: 'draft',
        created_at: iso(now - 1 * DAY),
        content: JSON.stringify(
        email([
          { type: 'text', text: 'Bonjour {{first_name}},' },
          { type: 'text', text: 'Pour vous remercier de votre confiance, je vous offre **-30 %** sur la formation complète jusqu’à dimanche minuit.' },
          { type: 'button', label: 'Profiter de l’offre', action: 'url', url: 'https://exemple.com/offre-clients', style: { align: 'center' } },
          { type: 'text', text: 'À bientôt,\nCamille' },
        ]),
      ),
      })
      .execute();

    // scheduled newsletter: in 3 days at 09:00 (Paris) — recipients are computed when it starts
    const sched = new Date(now + 3 * DAY);
    sched.setUTCHours(7, 0, 0, 0);
    await trx
      .insertInto('broadcasts')
      .values({
        user_id: userId,
        subject: '{{first_name}}, les inscriptions à la formation ouvrent jeudi',
        tag_id: lead.id,
        status: 'scheduled',
        scheduled_at: sched.toISOString(),
        created_at: iso(now - 2 * 3600_000),
        ab_test: JSON.stringify({ subjects: ['Ouverture des inscriptions : places limitées ⏳'], test_percent: 20, wait_hours: 4 }),
        content: JSON.stringify(
          email([
            { type: 'text', text: 'Bonjour {{first_name}},' },
            { type: 'text', text: 'C’est le grand jour jeudi : les inscriptions à **la formation complète** ouvrent à 9h, pour 72 heures seulement.' },
            { type: 'button', label: 'Réserver ma place', action: 'url', url: 'https://exemple.com/formation', style: { align: 'center' } },
            { type: 'text', text: 'À jeudi,\nCamille' },
          ]),
        ),
      })
      .execute();
    return userId;
  });

  // ---- "send" everything that is due (dev mode: rendered + marked sent), then backdate + fake engagement ----
  await new EmailWorker({ throttle: false, instanceId: 'seed' }).drain();
  await db.transaction().execute(async (trx) => {
    const sends = await trx.selectFrom('email_sends').select(['id', 'send_at']).where('user_id', '=', userId).where('status', '=', 'sent').orderBy('id').execute();
    for (const s of sends) {
      const t = new Date(s.send_at).getTime();
      const opened = rand() < 0.55 ? Math.min(Date.now() - 60_000, t + randInt(5, 600) * 60_000) : null;
      const clicked = opened && rand() < 0.4 ? Math.min(Date.now() - 30_000, opened + randInt(1, 30) * 60_000) : null;
      await trx
        .updateTable('email_sends')
        .set({ sent_at: s.send_at, opened_at: opened ? iso(opened) : null, clicked_at: clicked ? iso(clicked) : null })
        .where('id', '=', s.id)
        .execute();
    }
    // align "email_sent" events with the backdated send time
    await sql`
      UPDATE contact_events ev SET created_at = COALESCE((
        SELECT es.send_at FROM email_sends es
         WHERE es.contact_id = ev.contact_id AND es.subject = ev.data->>'subject' ORDER BY es.id LIMIT 1), ev.created_at)
       WHERE ev.user_id = ${userId} AND ev.type = 'email_sent'`.execute(trx);
  });

  const count = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(db)).rows[0].n;
  console.log('Seed terminé :');
  console.log(`  utilisateur  ${DEMO_EMAIL} / demo1234`);
  console.log(`  contacts     ${await count(sql`SELECT COUNT(*) AS n FROM contacts WHERE user_id = ${userId}`)}`);
  console.log(`  vues         ${await count(sql`SELECT COUNT(*) AS n FROM page_views WHERE user_id = ${userId}`)}`);
  console.log(`  optins       ${await count(sql`SELECT COUNT(*) AS n FROM contact_events WHERE user_id = ${userId} AND type = 'optin'`)}`);
  const sent = await count(sql`SELECT COUNT(*) AS n FROM email_sends WHERE user_id = ${userId} AND status = 'sent'`);
  const pending = await count(sql`SELECT COUNT(*) AS n FROM email_sends WHERE user_id = ${userId} AND status = 'pending'`);
  console.log(`  emails       ${sent} envoyés, ${pending} en attente`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());

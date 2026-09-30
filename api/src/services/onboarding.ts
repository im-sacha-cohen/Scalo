// Onboarding of a new account: state of the welcome flow (/welcome) and the "Bien démarrer" checklist of the dashboard.
//
// The checklist is never stored nor ticked by hand: every item is computed from the account's real data, so it is
// always true (a funnel deleted afterwards un-ticks "create a funnel").
import { sql } from 'kysely';
import type {
  AccountRole,
  OnboardingChecklist,
  OnboardingGoal,
  OnboardingItem,
  OnboardingItemId,
  OnboardingState,
  OnboardingUpdate,
} from '@scalo/shared';
import { roleAllows } from '../access';
import { db, nowIso, type Db } from '../db';
import { HttpError } from '../util';

/** What the account has really done: one round trip. */
interface Facts {
  sender: boolean;
  smtp: boolean;
  funnel_id: number | null;
  visitor: boolean;
  contacts: boolean;
  email: boolean;
  stripe: boolean;
  product: boolean;
  course: boolean;
  imports: boolean;
}

async function facts(userId: number, ex: Db): Promise<Facts> {
  const { rows } = await sql<Facts>`
    SELECT
      COALESCE((SELECT btrim(s.sender_name) <> '' AND btrim(s.sender_email) <> '' AND btrim(s.company_address) <> ''
                  FROM settings s WHERE s.user_id = ${userId}), false) AS sender,
      COALESCE((SELECT btrim(s.smtp_host) <> '' FROM settings s WHERE s.user_id = ${userId}), false) AS smtp,
      (SELECT f.id FROM funnels f WHERE f.user_id = ${userId} ORDER BY f.id DESC LIMIT 1) AS funnel_id,
      (EXISTS (SELECT 1 FROM page_views v WHERE v.user_id = ${userId})
        OR EXISTS (SELECT 1 FROM contact_events e WHERE e.user_id = ${userId} AND e.type = 'optin')) AS visitor,
      EXISTS (SELECT 1 FROM contacts c WHERE c.user_id = ${userId}) AS contacts,
      (EXISTS (SELECT 1 FROM broadcasts b WHERE b.user_id = ${userId} AND b.status IN ('scheduled', 'sent'))
        OR EXISTS (SELECT 1 FROM campaigns c WHERE c.user_id = ${userId})) AS email,
      EXISTS (SELECT 1 FROM payment_settings p WHERE p.user_id = ${userId} AND p.stripe_secret_key IS NOT NULL) AS stripe,
      EXISTS (SELECT 1 FROM products p WHERE p.user_id = ${userId} AND NOT p.archived) AS product,
      EXISTS (SELECT 1 FROM courses c WHERE c.user_id = ${userId}) AS course,
      EXISTS (SELECT 1 FROM import_jobs j WHERE j.user_id = ${userId}) AS imports`.execute(ex);
  return rows[0];
}

type ItemDef = Omit<OnboardingItem, 'id' | 'done' | 'href'> & { done: (f: Facts) => boolean; href: string | ((f: Facts) => string) };

/** Every possible item. Rule of each one: see `done`. */
const ITEMS: Record<OnboardingItemId, ItemDef> = {
  // sender name + sender email + postal address all filled in (Settings)
  sender: {
    title: 'Signez vos emails à votre nom',
    description: 'Nom d’expéditeur, adresse de réponse et adresse postale, exigée en pied de chaque email.',
    minutes: 1,
    href: '/settings',
    done: (f) => f.sender,
  },
  // at least one funnel exists
  funnel: {
    title: 'Mettez votre première page en ligne',
    description: 'Un tunnel créé depuis un modèle : il est publié tout de suite, avec sa propre adresse.',
    minutes: 2,
    href: '/funnels?new=1',
    done: (f) => f.funnel_id !== null,
  },
  // at least one page view or one opt-in recorded on a funnel page
  visitor: {
    title: 'Recevez votre premier visiteur',
    description: 'Partagez l’adresse de votre page : chaque visite et chaque inscription s’affichent ici.',
    minutes: 2,
    href: (f) => (f.funnel_id ? `/funnels/${f.funnel_id}` : '/funnels'),
    done: (f) => f.visitor,
  },
  // an SMTP server is configured (Settings); the SPF / DKIM / DMARC check of the domain is on the same screen
  sending: {
    title: 'Arrivez en boîte de réception',
    description: 'Branchez votre service d’envoi (SMTP), puis vérifiez SPF, DKIM et DMARC de votre domaine.',
    minutes: 5,
    href: '/settings',
    done: (f) => f.smtp,
  },
  // at least one contact (added by hand, imported, or captured by a page)
  contacts: {
    title: 'Réunissez vos contacts au même endroit',
    description: 'Importez un fichier CSV ou ajoutez vos premiers contacts à la main.',
    minutes: 3,
    href: '/contacts?import=1',
    done: (f) => f.contacts,
  },
  // a newsletter sent or scheduled, or a campaign created
  first_email: {
    title: 'Écrivez à vos contacts',
    description: 'Envoyez une première newsletter, ou créez une campagne qui accueille chaque nouvel inscrit.',
    minutes: 5,
    href: '/emails?tab=broadcasts&new=1',
    done: (f) => f.email,
  },
  // a Stripe secret key is stored for the account
  stripe: {
    title: 'Encaissez sur votre compte Stripe',
    description: 'Collez vos clés Stripe : les paiements arrivent directement chez vous, sans commission de Scalo.',
    minutes: 3,
    href: '/settings#paiements',
    done: (f) => f.stripe,
  },
  // at least one product that is not archived
  product: {
    title: 'Créez ce que vous vendez',
    description: 'Un produit et son prix : paiement unique, abonnement ou en plusieurs fois.',
    minutes: 2,
    href: '/sales?tab=products',
    done: (f) => f.product,
  },
  // at least one course
  course: {
    title: 'Préparez votre formation',
    description: 'Modules, leçons, vidéos et fichiers : vos élèves y accèdent dans leur espace membres.',
    minutes: 5,
    href: '/courses',
    done: (f) => f.course,
  },
  // at least one import started from the migration screen
  import: {
    title: 'Rapatriez vos contacts et vos tags',
    description: 'Importez depuis votre ancien outil ou un fichier CSV : tags, champs et abonnements sont repris.',
    minutes: 5,
    href: '/migrate',
    done: (f) => f.imports,
  },
};

/** Items of the checklist for each goal (no goal: the account skipped the welcome flow → the "capture emails" list). */
export const CHECKLISTS: Record<OnboardingGoal, OnboardingItemId[]> = {
  leads: ['sender', 'funnel', 'visitor', 'sending', 'contacts', 'first_email'],
  sell: ['sender', 'funnel', 'stripe', 'product', 'visitor', 'sending', 'first_email'],
  course: ['sender', 'course', 'stripe', 'product', 'funnel', 'sending', 'visitor'],
  migrate: ['sender', 'import', 'sending', 'funnel', 'first_email', 'visitor'],
};

function checklist(goal: OnboardingGoal | null, f: Facts, hidden: boolean): OnboardingChecklist {
  const items: OnboardingItem[] = CHECKLISTS[goal ?? 'leads'].map((id) => {
    const d = ITEMS[id];
    return { id, title: d.title, description: d.description, minutes: d.minutes, href: typeof d.href === 'function' ? d.href(f) : d.href, done: d.done(f) };
  });
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, complete: done === items.length, hidden };
}

/**
 * `accountId`: the account the request works on; `actorId` / `role`: the signed-in person (different from the account
 * for a team member of the Enterprise edition, who never sees the welcome flow).
 */
export async function onboardingState(accountId: number, actor: { actorId: number; role: AccountRole }, ex: Db = db): Promise<OnboardingState> {
  const [row, f] = await Promise.all([
    ex.selectFrom('account_onboarding').selectAll().where('user_id', '=', accountId).executeTakeFirst(),
    facts(accountId, ex),
  ]);
  const funnel = row?.funnel_id
    ? await ex
        .selectFrom('funnels as f')
        .select(['f.id', 'f.name', 'f.slug'])
        .select((eb) => eb.selectFrom('steps as s').select('s.id').whereRef('s.funnel_id', '=', 'f.id').orderBy('s.position').orderBy('s.id').limit(1).as('step_id'))
        .where('f.id', '=', row.funnel_id)
        .where('f.user_id', '=', accountId)
        .executeTakeFirst()
    : undefined;
  const member = actor.actorId !== accountId;
  let step = row?.step ?? 'goal';
  if (step === 'live' && !funnel) step = 'funnel'; // the funnel of the flow was deleted meanwhile
  return {
    required: !member && !row?.completed_at && !row?.skipped_at,
    member,
    can_edit: roleAllows(actor.role, 'PUT', '/onboarding'),
    goal: row?.goal ?? null,
    step,
    funnel: funnel ? { id: funnel.id, name: funnel.name, slug: funnel.slug, step_id: funnel.step_id ?? null } : null,
    import_started: f.imports,
    completed_at: row?.completed_at ?? null,
    skipped_at: row?.skipped_at ?? null,
    checklist: checklist(row?.goal ?? null, f, !!row?.checklist_hidden_at),
  };
}

export async function updateOnboarding(accountId: number, patch: OnboardingUpdate, ex: Db = db): Promise<void> {
  if (patch.funnel_id !== undefined) {
    const owned = await ex.selectFrom('funnels').select('id').where('id', '=', patch.funnel_id).where('user_id', '=', accountId).executeTakeFirst();
    if (!owned) throw new HttpError(404, 'Tunnel introuvable');
  }
  const now = nowIso();
  const set = {
    ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
    ...(patch.step !== undefined ? { step: patch.step } : {}),
    ...(patch.funnel_id !== undefined ? { funnel_id: patch.funnel_id } : {}),
    ...(patch.complete ? { completed_at: now } : {}),
    ...(patch.skip ? { skipped_at: now } : {}),
    ...(patch.checklist_hidden !== undefined ? { checklist_hidden_at: patch.checklist_hidden ? now : null } : {}),
    updated_at: now,
  };
  await ex
    .insertInto('account_onboarding')
    .values({ user_id: accountId, ...set })
    .onConflict((oc) =>
      oc.column('user_id').doUpdateSet({
        ...set,
        // the first date wins: finishing or skipping twice does not move it
        ...(patch.complete ? { completed_at: sql<string>`COALESCE(account_onboarding.completed_at, ${now}::timestamptz)` } : {}),
        ...(patch.skip ? { skipped_at: sql<string>`COALESCE(account_onboarding.skipped_at, ${now}::timestamptz)` } : {}),
      }),
    )
    .execute();
}

/** Accounts created outside the sign-up screen (demo seed) never see the welcome flow. */
export async function markOnboardingDone(userId: number, ex: Db = db): Promise<void> {
  const now = nowIso();
  await ex
    .insertInto('account_onboarding')
    .values({ user_id: userId, step: 'live', completed_at: now, checklist_hidden_at: now })
    .onConflict((oc) => oc.column('user_id').doNothing())
    .execute();
}

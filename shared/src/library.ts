// Ready-made content: page templates, email templates and the section library.
// Everything is built by functions so each insertion gets fresh block ids.
import type { Block, BlockStyle, BlockType, ColumnsBlock, PageContent, PageSettings, SectionBlock, StepType } from './types';
import { DEFAULT_EMAIL_SETTINGS, DEFAULT_SETTINGS } from './render';
import { createColumns, uid } from './templates';
import { walk } from './tree';

type B<T extends BlockType> = Extract<Block, { type: T }>;
const mk = <T extends BlockType>(type: T, props: Omit<B<T>, 'id' | 'type'>): B<T> => ({ id: uid(), type, ...props }) as unknown as B<T>;

const H = (text: string, level: 1 | 2 | 3 = 2, style?: BlockStyle) => mk('heading', { text, level, style });
const P = (text: string, style?: BlockStyle) => mk('text', { text, style });
const eyebrow = (text: string, color: string, align: 'left' | 'center' = 'center') =>
  P(text, { align, color, fontSize: 13, fontWeight: 700, letterSpacing: 2, paddingTop: 0, paddingBottom: 4 });
const btn = (label: string, opts: Partial<Omit<B<'button'>, 'id' | 'type' | 'label'>> = {}) =>
  mk('button', { label, action: 'next', size: 'lg', radius: 10, style: { align: 'center', paddingTop: 16 }, ...opts });
const img = (seed: string, w = 1200, h = 800, opts: Partial<Omit<B<'image'>, 'id' | 'type'>> = {}) =>
  mk('image', { src: `https://picsum.photos/seed/${seed}/${w}/${h}`, alt: '', width: 100, radius: 14, ...opts });
const section = (children: Block[], opts: Partial<Omit<SectionBlock, 'id' | 'type' | 'children'>> = {}): SectionBlock =>
  mk('section', { children, fullWidth: true, contentWidth: 1040, ...opts, style: { paddingTop: 80, paddingBottom: 80, ...opts.style } });
const row = (cols: Block[][], widths?: number[], opts: Partial<Omit<ColumnsBlock, 'id' | 'type' | 'columns'>> = {}): ColumnsBlock => ({
  ...createColumns(widths ?? cols.map(() => Math.round((100 / cols.length) * 100) / 100), cols),
  ...opts,
});
const form = (submitLabel: string, opts: Partial<Omit<B<'form'>, 'id' | 'type' | 'submitLabel'>> = {}) =>
  mk('form', {
    submitLabel,
    fields: [{ name: 'first_name', label: 'Votre prénom' }, { name: 'email', label: 'Votre meilleure adresse email', required: true }],
    tagName: 'lead',
    ...opts,
  });

const POPPINS = "Poppins, 'Helvetica Neue', Arial, sans-serif";
const INTER = "Inter, 'Helvetica Neue', Arial, sans-serif";
const PLAYFAIR = "'Playfair Display', Georgia, serif";
const MONTSERRAT = "Montserrat, 'Helvetica Neue', Arial, sans-serif";

const pageSettings = (p: Partial<PageSettings>): PageSettings => ({
  ...DEFAULT_SETTINGS,
  background: '#ffffff',
  contentBackground: '#ffffff',
  maxWidth: 1100,
  contentPadding: 0,
  ...p,
});

const inDays = (d: number) => {
  const t = new Date(Date.now() + d * 86400_000);
  t.setHours(19, 0, 0, 0);
  return t.toISOString();
};

// ================= sections (reusable building blocks) =================

function navbarSection(brand: string, cta = 'Commencer', dark = false): SectionBlock {
  return section([mk('navbar', { logoText: brand, links: [{ label: 'Programme', url: '#programme' }, { label: 'Témoignages', url: '#avis' }, { label: 'FAQ', url: '#faq' }], ctaLabel: cta, ctaUrl: '#inscription', style: { paddingTop: 0, paddingBottom: 0 } })], {
    style: { paddingTop: 14, paddingBottom: 14, background: dark ? '#0f172a' : '#ffffff', color: dark ? '#ffffff' : undefined, borderWidth: 0 },
  });
}

function heroCentered(o: { eyebrow: string; title: string; subtitle: string; cta: string; from: string; to: string; accent: string }): SectionBlock {
  return section(
    [
      eyebrow(o.eyebrow, '#c7d2fe'),
      H(o.title, 1, { align: 'center', fontSize: 52, mobileFontSize: 34, lineHeight: 1.12, color: '#ffffff', paddingTop: 8 }),
      P(o.subtitle, { align: 'center', fontSize: 20, color: '#e0e7ff', lineHeight: 1.6 }),
      btn(o.cta, { bg: '#ffffff', textColor: o.accent }),
    ],
    { contentWidth: 820, gradient: { from: o.from, to: o.to, angle: 135 }, style: { paddingTop: 110, paddingBottom: 110 } },
  );
}

function featuresGrid(accent: string, title = 'Tout ce qu’il vous faut pour réussir', bg = '#f8fafc'): SectionBlock {
  const f = (icon: string, t: string, text: string) => mk('feature', { icon, title: t, text, layout: 'top', iconBg: `${accent}1a` });
  return section(
    [
      eyebrow('LE PROGRAMME', accent),
      H(title, 2, { align: 'center', fontSize: 38, mobileFontSize: 28, paddingBottom: 32 }),
      row([
        [f('🎯', 'Une stratégie claire', 'Un plan d’action simple, étape par étape, pour savoir exactement quoi faire chaque jour.')],
        [f('⚡', 'Des résultats rapides', 'Des techniques testées sur le terrain pour obtenir vos premiers résultats en quelques jours.')],
        [f('🤝', 'Un accompagnement', 'Posez vos questions à tout moment : notre équipe et la communauté sont là pour vous aider.')],
      ], undefined, { gap: 32 }),
    ],
    { style: { background: bg } },
  );
}

function testimonialsRow(bg = '#ffffff'): SectionBlock {
  const t = (quote: string, name: string, role: string, seed: string) =>
    mk('testimonial', { quote, name, role, stars: 5, layout: 'card', photo: `https://picsum.photos/seed/${seed}/120/120` });
  return section(
    [
      H('Ils sont passés à l’action', 2, { align: 'center', fontSize: 38, mobileFontSize: 28 }),
      P('Plus de 2 400 membres nous font déjà confiance.', { align: 'center', color: '#64748b', paddingBottom: 28 }),
      row([
        [t('J’ai enfin une méthode claire. En 6 semaines, j’ai signé mes 3 premiers clients.', 'Sophie L.', 'Consultante RH', 'sophie')],
        [t('Le meilleur investissement de l’année. Le contenu est concret et très bien expliqué.', 'Thomas R.', 'Photographe', 'thomas')],
        [t('Je recommande les yeux fermés. L’accompagnement fait toute la différence.', 'Nadia B.', 'Naturopathe', 'nadia')],
      ], undefined, { gap: 24 }),
    ],
    { style: { background: bg } },
  );
}

function pricingRow(accent: string): SectionBlock {
  return section(
    [
      eyebrow('TARIFS', accent),
      H('Choisissez la formule qui vous convient', 2, { align: 'center', fontSize: 38, mobileFontSize: 28, paddingBottom: 32 }),
      row([
        [mk('pricing', { title: 'Essentiel', price: '47 €', period: 'paiement unique', description: 'Pour bien démarrer', features: ['Les 6 modules vidéo', 'Fiches pratiques à télécharger', 'Accès à vie'], buttonLabel: 'Je choisis Essentiel', action: 'next', accent })],
        [mk('pricing', { title: 'Premium', price: '97 €', period: 'paiement unique', description: 'Le plus complet', features: ['Tout Essentiel', 'Communauté privée', '2 sessions de coaching en groupe', 'Bonus : modèles prêts à l’emploi'], buttonLabel: 'Je choisis Premium', action: 'next', highlighted: true, badge: 'Le plus choisi', accent })],
      ], undefined, { gap: 28, valign: 'center' }),
    ],
    { contentWidth: 860, style: { background: '#f8fafc' } },
  );
}

function faqSection(accent: string): SectionBlock {
  return section(
    [
      eyebrow('FAQ', accent),
      H('Questions fréquentes', 2, { align: 'center', fontSize: 38, mobileFontSize: 28, paddingBottom: 20 }),
      mk('faq', {
        openFirst: true,
        items: [
          { q: 'Combien de temps faut-il y consacrer ?', a: 'Environ 30 minutes par jour suffisent. Les leçons sont courtes et vous avancez à votre rythme.' },
          { q: 'Est-ce adapté aux débutants ?', a: 'Oui ! Le programme part de zéro et vous guide pas à pas, sans jargon technique.' },
          { q: 'Comment accéder au contenu ?', a: 'Vous recevez vos accès par email immédiatement après votre inscription.' },
          { q: 'Y a-t-il une garantie ?', a: 'Oui, vous êtes couvert par une garantie satisfait ou remboursé de 30 jours.' },
        ],
      }),
    ],
    { contentWidth: 760 },
  );
}

function ctaBand(o: { title: string; text: string; cta: string; bg: string; action?: 'next' | 'url' }): SectionBlock {
  return section(
    [
      H(o.title, 2, { align: 'center', color: '#ffffff', fontSize: 36, mobileFontSize: 26 }),
      P(o.text, { align: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 18 }),
      btn(o.cta, { bg: '#ffffff', textColor: o.bg, action: o.action ?? 'next' }),
    ],
    { contentWidth: 760, style: { background: o.bg, paddingTop: 72, paddingBottom: 72 } },
  );
}

function footerSection(brand: string, dark = true): SectionBlock {
  return section(
    [
      mk('social', { variant: 'outline', size: 38, links: [{ network: 'facebook', url: 'https://facebook.com/' }, { network: 'instagram', url: 'https://instagram.com/' }, { network: 'youtube', url: 'https://youtube.com/' }], style: { align: 'center' } }),
      mk('footer', { text: `Une question ? Écrivez-nous : contact@${brand.toLowerCase().replace(/[^a-z]/g, '')}.fr`, links: [{ label: 'Mentions légales', url: '#' }, { label: 'Politique de confidentialité', url: '#' }, { label: 'CGV', url: '#' }], copyright: `© ${new Date().getFullYear()} ${brand}. Tous droits réservés.`, style: { align: 'center' } }),
    ],
    { style: { paddingTop: 40, paddingBottom: 40, background: dark ? '#0f172a' : '#f8fafc', color: dark ? '#cbd5e1' : '#475569' } },
  );
}

function optinSplit(accent: string, o: { title: string; text: string; bullets: string[]; cta: string; seed?: string }): SectionBlock {
  return section(
    [
      row(
        [
          [
            eyebrow('GUIDE GRATUIT', accent, 'left'),
            H(o.title, 1, { fontSize: 44, mobileFontSize: 32, lineHeight: 1.15, paddingTop: 6 }),
            P(o.text, { color: '#475569', fontSize: 18 }),
            mk('list', { items: o.bullets, icon: 'check', style: { fontSize: 17 } }),
          ],
          [
            ...(o.seed ? [img(o.seed, 800, 520, { radius: 12, style: { paddingBottom: 4 } })] : []),
            H('Recevez-le gratuitement', 3, { align: 'center', paddingTop: 16 }),
            form(o.cta, { buttonBg: accent }),
            P('🔒 Vos données restent confidentielles. Désinscription en 1 clic.', { align: 'center', color: '#94a3b8', fontSize: 13, paddingTop: 0 }),
          ],
        ],
        [55, 45],
        { gap: 48, valign: 'center' },
      ),
    ],
    { style: { paddingTop: 72, paddingBottom: 72, background: '#f8fafc' } },
  );
}

// ================= page templates =================

export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  category: 'Capture' | 'Webinaire' | 'Vente' | 'Remerciement' | 'Lancement';
  stepType: StepType;
  build: () => PageContent;
}

export const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: 'optin-split',
    name: 'Capture — guide gratuit',
    description: 'Titre + bénéfices à gauche, formulaire en carte à droite.',
    category: 'Capture',
    stepType: 'optin',
    build: () => {
      const accent = '#5b4bff';
      const hero = optinSplit(accent, {
        title: 'Les 7 secrets pour doubler vos ventes en 30 jours',
        text: 'Le guide PDF de 32 pages qui a déjà aidé plus de 5 000 entrepreneurs à attirer des clients sans publicité.',
        bullets: ['La méthode exacte, étape par étape', 'Les 3 erreurs qui font fuir vos prospects', 'Des modèles de messages prêts à copier'],
        cta: 'Recevoir le guide gratuit',
      });
      // put the form column in a white card
      const cols = hero.children[0] as ColumnsBlock;
      cols.columns[1]!.background = '#ffffff';
      cols.columns[1]!.padding = 28;
      cols.style = { ...cols.style, paddingTop: 0, paddingBottom: 0 };
      return {
        settings: pageSettings({ accent, fontFamily: INTER, headingFont: POPPINS, seoTitle: 'Guide gratuit — 7 secrets pour doubler vos ventes' }),
        blocks: [
          navbarSection('Croissance+', 'Recevoir le guide'),
          hero,
          section([
            mk('rating', { value: 5, caption: 'Noté 4,9/5 par plus de 1 200 lecteurs', style: { align: 'center' } }),
            row([
              [mk('testimonial', { quote: 'Clair, concret, applicable tout de suite. J’ai signé 2 clients la semaine suivante.', name: 'Julie M.', role: 'Graphiste freelance', stars: 5, layout: 'plain', style: { align: 'center' } })],
              [mk('testimonial', { quote: 'Le meilleur guide gratuit que j’ai lu cette année, de loin.', name: 'Karim D.', role: 'Coach sportif', stars: 5, layout: 'plain', style: { align: 'center' } })],
            ], undefined, { gap: 40 }),
          ], { contentWidth: 900, style: { paddingTop: 56, paddingBottom: 56 } }),
          footerSection('Croissance+', false),
        ],
      };
    },
  },
  {
    id: 'optin-minimal',
    name: 'Capture — minimaliste sombre',
    description: 'Une page épurée et centrée, idéale pour une newsletter.',
    category: 'Capture',
    stepType: 'optin',
    build: () => {
      const accent = '#f59e0b';
      return {
        settings: pageSettings({ accent, background: '#0b1120', contentBackground: '#0b1120', textColor: '#f8fafc', fontFamily: INTER, headingFont: MONTSERRAT, maxWidth: 980 }),
        blocks: [
          section(
            [
              P('📬 LA NEWSLETTER DU DIMANCHE', { align: 'center', color: accent, fontSize: 13, fontWeight: 700, letterSpacing: 2 }),
              H('Une idée par semaine pour développer votre activité', 1, { align: 'center', fontSize: 46, mobileFontSize: 32, lineHeight: 1.15 }),
              P('Rejoignez 12 000 indépendants qui reçoivent chaque dimanche une stratégie concrète, testée et applicable en moins d’une heure.', { align: 'center', color: '#94a3b8', fontSize: 19 }),
              mk('spacer', { height: 12 }),
              form('Je m’abonne gratuitement', { buttonBg: accent, buttonColor: '#0b1120', fields: [{ name: 'email', label: 'Votre adresse email', required: true }] }),
              P('Gratuit · Sans spam · Désinscription en 1 clic', { align: 'center', color: '#64748b', fontSize: 14 }),
              mk('spacer', { height: 24 }),
              row([
                [mk('feature', { icon: '⏱️', title: '5 min de lecture', text: 'Directement dans votre boîte mail.', iconBg: '#1e293b', style: { color: '#e2e8f0' } })],
                [mk('feature', { icon: '🧪', title: 'Testé sur le terrain', text: 'Uniquement des méthodes éprouvées.', iconBg: '#1e293b', style: { color: '#e2e8f0' } })],
                [mk('feature', { icon: '🎁', title: 'Bonus offert', text: 'Notre checklist de lancement.', iconBg: '#1e293b', style: { color: '#e2e8f0' } })],
              ], undefined, { gap: 24 }),
            ],
            { contentWidth: 720, minHeight: 720, style: { paddingTop: 96, paddingBottom: 96 } },
          ),
        ],
      };
    },
  },
  {
    id: 'webinar',
    name: 'Inscription webinaire',
    description: 'Compte à rebours, programme, présentateur et formulaire.',
    category: 'Webinaire',
    stepType: 'optin',
    build: () => {
      const accent = '#7c3aed';
      return {
        settings: pageSettings({ accent, fontFamily: INTER, headingFont: POPPINS, seoTitle: 'Masterclass gratuite — inscription' }),
        blocks: [
          section(
            [
              P('🎥 MASTERCLASS GRATUITE EN DIRECT', { align: 'center', color: '#ddd6fe', fontSize: 13, fontWeight: 700, letterSpacing: 2 }),
              H('Comment créer une formation en ligne rentable en 60 jours', 1, { align: 'center', color: '#ffffff', fontSize: 48, mobileFontSize: 32, lineHeight: 1.15 }),
              P('Jeudi à 19h · 60 minutes · Replay offert aux inscrits', { align: 'center', color: '#ede9fe', fontSize: 19 }),
              mk('countdown', { mode: 'date', date: inDays(7), showLabels: true, boxBg: 'rgba(255,255,255,0.14)', boxColor: '#ffffff', expiredText: 'La masterclass a commencé !', style: { align: 'center', paddingTop: 20 } }),
              btn('Je réserve ma place', { bg: '#ffffff', textColor: accent, action: 'url', url: '#inscription' }),
            ],
            { contentWidth: 860, gradient: { from: '#4c1d95', to: '#7c3aed', angle: 135 }, style: { paddingTop: 96, paddingBottom: 96 } },
          ),
          section(
            [
              H('Pendant cette masterclass, vous découvrirez :', 2, { align: 'center', fontSize: 34, mobileFontSize: 26, paddingBottom: 24 }),
              row([
                [mk('feature', { icon: '1️⃣', title: 'Trouver le bon sujet', text: 'La méthode pour valider votre idée avant d’enregistrer la moindre vidéo.', layout: 'left' })],
                [mk('feature', { icon: '2️⃣', title: 'Construire l’offre', text: 'Structurer un programme que vos clients termineront (et recommanderont).', layout: 'left' })],
                [mk('feature', { icon: '3️⃣', title: 'Vendre sans forcer', text: 'Le tunnel simple qui transforme vos abonnés en clients satisfaits.', layout: 'left' })],
              ], undefined, { gap: 32 }),
            ],
          ),
          section(
            [
              mk('imageText', {
                src: 'https://picsum.photos/seed/presenter/800/800', alt: 'Présentatrice', imagePosition: 'left', imageWidth: 40, radius: 999,
                title: 'Votre hôte : Claire Dubois', text: 'Formatrice depuis 12 ans, Claire a accompagné plus de 800 experts dans le lancement de leur formation en ligne. Elle partage ici, sans filtre, ce qui fonctionne vraiment en 2026.',
              }),
            ],
            { contentWidth: 900, style: { background: '#f5f3ff' } },
          ),
          section(
            [
              H('Réservez votre place gratuite', 2, { align: 'center', fontSize: 34, mobileFontSize: 26 }),
              mk('progress', { value: 83, label: 'Places déjà réservées', barColor: accent, striped: true, style: { paddingTop: 16, paddingBottom: 20 } }),
              form('Je m’inscris à la masterclass', { buttonBg: accent, tagName: 'webinaire' }),
            ],
            { contentWidth: 560 },
          ),
          footerSection('Académie Claire', true),
        ],
      };
    },
  },
  {
    id: 'sales',
    name: 'Page de vente complète',
    description: 'Vidéo, bénéfices, témoignages, tarifs, FAQ et appel à l’action.',
    category: 'Vente',
    stepType: 'sales',
    build: () => {
      const accent = '#ea580c';
      return {
        settings: pageSettings({ accent, fontFamily: INTER, headingFont: POPPINS, seoTitle: 'La formation complète pour lancer votre activité' }),
        blocks: [
          navbarSection('Lancement Pro', 'Rejoindre', true),
          section(
            [
              eyebrow('NOUVELLE FORMATION 2026', accent),
              H('Lancez votre activité en ligne et trouvez vos premiers clients en 90 jours', 1, { align: 'center', fontSize: 46, mobileFontSize: 30, lineHeight: 1.15 }),
              P('La formation pas à pas qui vous évite 2 ans d’essais et d’erreurs.', { align: 'center', fontSize: 20, color: '#475569' }),
              mk('video', { url: '', style: { paddingTop: 20, paddingBottom: 20, shadow: 'lg' } }),
              btn('Je rejoins la formation', { bg: accent }),
              mk('rating', { value: 5, size: 20, caption: '4,9/5 — plus de 2 400 élèves', style: { align: 'center' } }),
            ],
            { contentWidth: 860 },
          ),
          featuresGrid(accent, 'Ce que vous allez obtenir'),
          testimonialsRow(),
          pricingRow(accent),
          faqSection(accent),
          ctaBand({ title: 'Prêt(e) à passer à l’action ?', text: 'Garantie satisfait ou remboursé 30 jours. Vous ne prenez aucun risque.', cta: 'Oui, je rejoins la formation', bg: accent }),
          footerSection('Lancement Pro'),
        ],
      };
    },
  },
  {
    id: 'thankyou',
    name: 'Remerciement',
    description: 'Confirmation chaleureuse, prochaines étapes et réseaux sociaux.',
    category: 'Remerciement',
    stepType: 'thankyou',
    build: () => {
      const accent = '#059669';
      return {
        settings: pageSettings({ accent, fontFamily: INTER, headingFont: POPPINS, maxWidth: 1000 }),
        blocks: [
          section(
            [
              P('🎉', { align: 'center', fontSize: 56, paddingBottom: 0 }),
              H('Merci {{first_name}}, c’est confirmé !', 1, { align: 'center', fontSize: 44, mobileFontSize: 30 }),
              P('Votre inscription est bien enregistrée. Il ne reste plus qu’une étape pour recevoir votre cadeau.', { align: 'center', fontSize: 19, color: '#475569' }),
              mk('progress', { value: 90, label: 'Presque terminé', barColor: accent, style: { paddingTop: 16, paddingBottom: 16 } }),
            ],
            { contentWidth: 720, style: { background: '#ecfdf5', paddingTop: 88, paddingBottom: 56 } },
          ),
          section(
            [
              row([
                [mk('feature', { icon: '📧', title: '1. Ouvrez votre boîte mail', text: 'Un email vient de vous être envoyé. Pensez à vérifier l’onglet Promotions ou vos spams.', iconBg: '#d1fae5' })],
                [mk('feature', { icon: '✅', title: '2. Confirmez votre adresse', text: 'Cliquez sur le lien de confirmation pour recevoir immédiatement votre guide.', iconBg: '#d1fae5' })],
                [mk('feature', { icon: '📚', title: '3. Passez à l’action', text: 'Lisez le guide et appliquez la première méthode dès aujourd’hui.', iconBg: '#d1fae5' })],
              ], undefined, { gap: 28 }),
            ],
            { style: { paddingTop: 56, paddingBottom: 56 } },
          ),
          section(
            [
              H('En attendant, rejoignez la communauté', 3, { align: 'center' }),
              mk('social', { variant: 'brand', size: 44, links: [{ network: 'instagram', url: 'https://instagram.com/' }, { network: 'youtube', url: 'https://youtube.com/' }, { network: 'linkedin', url: 'https://linkedin.com/' }], style: { align: 'center' } }),
            ],
            { contentWidth: 720, style: { paddingTop: 24, paddingBottom: 72 } },
          ),
        ],
      };
    },
  },
  {
    id: 'lead-magnet',
    name: 'Aimant à prospects (ebook)',
    description: 'Couverture de l’ebook, sommaire, preuve sociale et formulaire.',
    category: 'Capture',
    stepType: 'optin',
    build: () => {
      const accent = '#0284c7';
      return {
        settings: pageSettings({ accent, fontFamily: INTER, headingFont: PLAYFAIR, seoTitle: 'Ebook offert — Le guide du marketing par email' }),
        blocks: [
          section(
            [
              row(
                [
                  [img('ebook-cover', 700, 900, { radius: 10, width: 85, style: { align: 'center', shadow: 'xl', borderRadius: 10, paddingTop: 0, paddingBottom: 0 } })],
                  [
                    eyebrow('EBOOK OFFERT', accent, 'left'),
                    H('Le guide complet de l’email marketing', 1, { fontSize: 46, mobileFontSize: 32, lineHeight: 1.12 }),
                    P('48 pages pour construire une liste d’abonnés engagés et la transformer en clients fidèles — même si vous partez de zéro.', { fontSize: 18, color: '#475569' }),
                    form('Télécharger l’ebook', { buttonBg: accent, tagName: 'ebook' }),
                  ],
                ],
                [42, 58],
                { gap: 56, valign: 'center' },
              ),
            ],
            { gradient: { from: '#f0f9ff', to: '#e0f2fe', angle: 180 }, style: { paddingTop: 88, paddingBottom: 88 } },
          ),
          section(
            [
              H('Au sommaire', 2, { align: 'center', fontSize: 36, mobileFontSize: 28, paddingBottom: 16 }),
              row([
                [mk('list', { icon: 'number', items: ['Choisir le bon outil (et éviter les pièges)', 'Créer un aimant irrésistible', 'Écrire des objets qui donnent envie d’ouvrir'] })],
                [mk('list', { icon: 'number', items: ['La séquence de bienvenue idéale', 'Vendre par email sans être insistant', 'Mesurer et améliorer vos résultats'] })],
              ], undefined, { gap: 32 }),
            ],
            { contentWidth: 900 },
          ),
          section(
            [mk('quote', { text: 'Ce guide m’a permis de passer de 200 à 3 000 abonnés en six mois. Tout est expliqué simplement, avec des exemples concrets.', author: 'Élodie P., fondatrice de Maison Lumen', style: { fontSize: 24 } })],
            { contentWidth: 760, style: { background: '#f8fafc', paddingTop: 64, paddingBottom: 64 } },
          ),
          ctaBand({ title: 'Recevez votre exemplaire gratuit', text: 'Plus de 9 000 téléchargements. Envoyé instantanément par email.', cta: 'Je veux l’ebook', bg: accent, action: 'url' }),
          footerSection('Lumen Marketing', false),
        ],
      };
    },
  },
  {
    id: 'coming-soon',
    name: 'Bientôt disponible',
    description: 'Plein écran avec image de fond, compte à rebours et liste d’attente.',
    category: 'Lancement',
    stepType: 'optin',
    build: () => {
      const accent = '#ec4899';
      return {
        settings: pageSettings({ accent, background: '#0f172a', contentBackground: '#0f172a', textColor: '#ffffff', fontFamily: INTER, headingFont: MONTSERRAT }),
        blocks: [
          section(
            [
              P('BIENTÔT DISPONIBLE', { align: 'center', color: accent, fontSize: 14, fontWeight: 800, letterSpacing: 4 }),
              H('Quelque chose de grand se prépare', 1, { align: 'center', fontSize: 56, mobileFontSize: 36, lineHeight: 1.1 }),
              P('Inscrivez-vous sur la liste d’attente pour être prévenu(e) en premier et profiter de −40 % au lancement.', { align: 'center', fontSize: 19, color: '#e2e8f0' }),
              mk('countdown', { mode: 'date', date: inDays(21), showLabels: true, boxBg: 'rgba(255,255,255,0.12)', boxColor: '#ffffff', style: { align: 'center', paddingTop: 16, paddingBottom: 16 } }),
              form('Rejoindre la liste d’attente', { buttonBg: accent, fields: [{ name: 'email', label: 'Votre adresse email', required: true }], tagName: 'liste-attente' }),
              mk('social', { variant: 'outline', size: 36, links: [{ network: 'instagram', url: 'https://instagram.com/' }, { network: 'tiktok', url: 'https://tiktok.com/' }, { network: 'x', url: 'https://x.com/' }], style: { align: 'center', paddingTop: 24 } }),
            ],
            {
              contentWidth: 720, minHeight: 760, valign: 'center', bgImage: 'https://picsum.photos/seed/launch-night/1920/1200', overlayColor: '#0f172a', overlayOpacity: 72,
              style: { paddingTop: 80, paddingBottom: 80 },
            },
          ),
        ],
      };
    },
  },
];

/** Default page used when a step is created without choosing a template. */
export function pageTemplateForStep(type: StepType): PageContent {
  const id = type === 'optin' ? 'optin-split' : type === 'sales' ? 'sales' : type === 'thankyou' ? 'thankyou' : null;
  const t = id && PAGE_TEMPLATES.find((x) => x.id === id);
  if (t) return t.build();
  return {
    settings: pageSettings({ fontFamily: INTER }),
    blocks: [section([H('Nouvelle page', 1, { align: 'center' }), P('Ajoutez des blocs depuis la palette de gauche ou choisissez un modèle.', { align: 'center', color: '#64748b' })])],
  };
}

// ================= email templates =================

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  build: () => PageContent;
}

const emailSettings = (p: Partial<PageSettings> = {}): PageSettings => ({ ...DEFAULT_EMAIL_SETTINGS, background: '#f1f5f9', ...p });
const emailFooter = (brand: string) =>
  section([
    mk('social', { variant: 'dark', size: 32, links: [{ network: 'facebook', url: 'https://facebook.com/' }, { network: 'instagram', url: 'https://instagram.com/' }, { network: 'linkedin', url: 'https://linkedin.com/' }], style: { align: 'center' } }),
    mk('footer', { text: `Vous recevez cet email car vous êtes abonné(e) à ${brand}.`, links: [{ label: 'Notre site', url: 'https://exemple.fr' }], style: { align: 'center', paddingTop: 4 } }),
  ], { fullWidth: false, style: { background: '#f8fafc', paddingTop: 24, paddingBottom: 24 } });

export const EMAIL_TEMPLATES: EmailTemplate[] = [
  {
    id: 'newsletter',
    name: 'Newsletter',
    description: 'Logo, image à la une, article principal et deux articles en colonnes.',
    build: () => ({
      settings: emailSettings({ accent: '#5b4bff', preheader: 'Au programme cette semaine : 3 idées à appliquer tout de suite.' }),
      blocks: [
        mk('navbar', { logoText: 'La Lettre+', links: [], style: { align: 'center', paddingTop: 20, paddingBottom: 12 } }),
        img('newsletter-hero', 1200, 600, { radius: 0, style: { paddingTop: 0, paddingBottom: 0, paddingX: 0 } }),
        H('3 idées pour relancer votre activité cette semaine', 1, { fontSize: 28, paddingTop: 24 }),
        P('Bonjour {{first_name}},\n\nCette semaine, on parle de régularité, de contenu recyclé et d’une astuce toute simple pour doubler vos réponses aux emails. Bonne lecture !'),
        btn('Lire l’article complet', { action: 'url', url: 'https://exemple.fr/blog', size: 'md', style: { align: 'left', paddingTop: 8 } }),
        mk('divider', { style: { paddingTop: 20, paddingBottom: 20 } }),
        row([
          [img('article-a', 600, 400, { radius: 8 }), H('Recycler vos meilleurs contenus', 3), P('Transformez un article en 5 publications sans y passer la journée.'), btn('Lire', { action: 'url', url: 'https://exemple.fr/a', size: 'sm', variant: 'outline', style: { align: 'left' } })],
          [img('article-b', 600, 400, { radius: 8 }), H('L’objet parfait en 3 étapes', 3), P('La formule qui fait grimper votre taux d’ouverture.'), btn('Lire', { action: 'url', url: 'https://exemple.fr/b', size: 'sm', variant: 'outline', style: { align: 'left' } })],
        ]),
        emailFooter('La Lettre+'),
      ],
    }),
  },
  {
    id: 'welcome',
    name: 'Bienvenue',
    description: 'Accueillir un nouvel abonné et présenter les prochaines étapes.',
    build: () => ({
      settings: emailSettings({ accent: '#059669', preheader: 'Votre cadeau est à l’intérieur 🎁' }),
      blocks: [
        section([
          P('👋', { align: 'center', fontSize: 44, paddingBottom: 0 }),
          H('Bienvenue {{first_name}} !', 1, { align: 'center', color: '#ffffff', fontSize: 30 }),
          P('Merci de nous avoir rejoints. Voici votre cadeau, comme promis.', { align: 'center', color: '#d1fae5' }),
        ], { fullWidth: false, gradient: { from: '#047857', to: '#10b981', angle: 135 }, style: { paddingTop: 40, paddingBottom: 40 } }),
        P('Bonjour {{first_name}},\n\nJe suis ravie de vous compter parmi nous. Dans les prochains jours, vous recevrez mes meilleurs conseils pour avancer rapidement.', { paddingTop: 24 }),
        btn('Télécharger mon guide', { action: 'url', url: 'https://exemple.fr/guide.pdf', bg: '#059669' }),
        H('Les prochaines étapes', 3, { paddingTop: 20 }),
        mk('list', { icon: 'check', items: ['Ajoutez notre adresse à vos contacts', 'Lisez le guide (15 minutes suffisent)', 'Répondez à cet email pour me dire où vous en êtes'] }),
        P('À très vite,\n**Claire**'),
        emailFooter('Académie Claire'),
      ],
    }),
  },
  {
    id: 'promo',
    name: 'Promotion',
    description: 'Offre limitée avec grand titre, bénéfices et bouton d’achat.',
    build: () => ({
      settings: emailSettings({ accent: '#dc2626', preheader: '−30 % jusqu’à dimanche minuit seulement' }),
      blocks: [
        mk('navbar', { logoText: 'Lancement Pro', links: [], style: { align: 'center', paddingTop: 20, paddingBottom: 8 } }),
        section([
          P('OFFRE LIMITÉE', { align: 'center', color: '#fecaca', fontSize: 13, fontWeight: 700, letterSpacing: 3 }),
          H('−30 % sur toute la formation', 1, { align: 'center', color: '#ffffff', fontSize: 36 }),
          P('Jusqu’à dimanche minuit uniquement', { align: 'center', color: '#fee2e2' }),
          btn('J’en profite maintenant', { action: 'url', url: 'https://exemple.fr/offre', bg: '#ffffff', textColor: '#dc2626' }),
        ], { fullWidth: false, style: { background: '#dc2626', paddingTop: 40, paddingBottom: 40 } }),
        P('Bonjour {{first_name}},\n\nC’est le moment idéal pour rejoindre la formation : pendant 72 heures, vous bénéficiez de 30 % de réduction et de tous les bonus.', { paddingTop: 24 }),
        row([
          [mk('feature', { icon: '🎓', title: '8 modules', text: 'Plus de 40 leçons vidéo' })],
          [mk('feature', { icon: '💬', title: 'Communauté', text: 'Entraide et coaching' })],
          [mk('feature', { icon: '🛡️', title: 'Garantie', text: '30 jours remboursé' })],
        ]),
        mk('testimonial', { quote: 'La formation m’a permis de lancer mon activité en 3 mois. Merci !', name: 'Thomas R.', role: 'Photographe', stars: 5, layout: 'card', cardBg: '#fef2f2' }),
        btn('Je rejoins la formation à −30 %', { action: 'url', url: 'https://exemple.fr/offre', bg: '#dc2626', fullWidth: true }),
        emailFooter('Lancement Pro'),
      ],
    }),
  },
  {
    id: 'simple',
    name: 'Texte simple',
    description: 'Un email personnel, sobre, comme écrit à la main.',
    build: () => ({
      settings: emailSettings({ background: '#ffffff', contentBackground: '#ffffff', fontFamily: 'Georgia, serif', preheader: '' }),
      blocks: [
        P('Bonjour {{first_name}},'),
        P('Je voulais vous écrire un petit mot personnel aujourd’hui.\n\nÉcrivez ici votre message, comme vous le feriez à un ami. Les emails simples ont souvent les meilleurs taux de réponse.'),
        P('Qu’en pensez-vous ? Répondez simplement à cet email, je lis toutes les réponses.'),
        P('Belle journée,\nClaire'),
      ],
    }),
  },
];

// ================= section library =================

export interface SectionTemplate {
  id: string;
  name: string;
  category: 'En-tête' | 'Hero' | 'Contenu' | 'Preuve sociale' | 'Offre' | 'Conversion' | 'Pied de page';
  modes: ('page' | 'email')[];
  build: (accent: string) => Block;
}

export const SECTION_TEMPLATES: SectionTemplate[] = [
  { id: 'navbar', name: 'Barre de navigation', category: 'En-tête', modes: ['page'], build: () => navbarSection('MaMarque') },
  { id: 'logo-header', name: 'Logo centré', category: 'En-tête', modes: ['page', 'email'], build: () => mk('navbar', { logoText: 'MaMarque', links: [], style: { align: 'center', paddingTop: 20, paddingBottom: 12 } }) },
  {
    id: 'hero-gradient', name: 'Hero dégradé', category: 'Hero', modes: ['page', 'email'],
    build: (accent) => heroCentered({ eyebrow: 'NOUVEAU', title: 'Un titre fort qui présente votre promesse', subtitle: 'Un sous-titre qui précise le bénéfice principal pour votre visiteur.', cta: 'Je découvre', from: '#1e1b4b', to: accent, accent }),
  },
  {
    id: 'hero-split', name: 'Hero + formulaire', category: 'Hero', modes: ['page'],
    build: (accent) => optinSplit(accent, { title: 'Téléchargez votre guide gratuit', text: 'Décrivez en une phrase ce que votre visiteur va obtenir.', bullets: ['Premier bénéfice concret', 'Deuxième bénéfice concret', 'Troisième bénéfice concret'], cta: 'Je le veux' }),
  },
  {
    id: 'hero-image', name: 'Hero image de fond', category: 'Hero', modes: ['page'],
    build: () => section([
      H('Transformez votre passion en métier', 1, { align: 'center', color: '#ffffff', fontSize: 50, mobileFontSize: 32 }),
      P('Le programme qui vous accompagne de l’idée aux premiers clients.', { align: 'center', color: '#e2e8f0', fontSize: 20 }),
      btn('Commencer maintenant'),
    ], { contentWidth: 800, minHeight: 560, bgImage: 'https://picsum.photos/seed/hero-bg/1920/1080', overlayColor: '#0f172a', overlayOpacity: 60 }),
  },
  { id: 'features', name: 'Grille d’atouts (3)', category: 'Contenu', modes: ['page', 'email'], build: (accent) => featuresGrid(accent) },
  {
    id: 'image-text', name: 'Image + texte', category: 'Contenu', modes: ['page', 'email'],
    build: () => section([mk('imageText', { src: 'https://picsum.photos/seed/about/800/600', alt: '', imagePosition: 'left', imageWidth: 45, title: 'Qui suis-je ?', text: 'Présentez-vous en quelques lignes : votre parcours, votre mission et pourquoi vous êtes la bonne personne pour aider votre visiteur.', buttonLabel: 'En savoir plus', buttonAction: 'next' })]),
  },
  {
    id: 'video', name: 'Vidéo de présentation', category: 'Contenu', modes: ['page', 'email'],
    build: () => section([H('Découvrez la méthode en 3 minutes', 2, { align: 'center', fontSize: 34, mobileFontSize: 26 }), mk('video', { url: '', style: { paddingTop: 16 } })], { contentWidth: 820 }),
  },
  { id: 'testimonials', name: 'Témoignages (3)', category: 'Preuve sociale', modes: ['page', 'email'], build: () => testimonialsRow('#f8fafc') },
  {
    id: 'stats', name: 'Chiffres clés', category: 'Preuve sociale', modes: ['page', 'email'],
    build: (accent) => section([row([
      [H('2 400+', 2, { align: 'center', color: accent, fontSize: 42 }), P('élèves accompagnés', { align: 'center', color: '#64748b', paddingTop: 0 })],
      [H('4,9/5', 2, { align: 'center', color: accent, fontSize: 42 }), P('note moyenne', { align: 'center', color: '#64748b', paddingTop: 0 })],
      [H('30 j', 2, { align: 'center', color: accent, fontSize: 42 }), P('satisfait ou remboursé', { align: 'center', color: '#64748b', paddingTop: 0 })],
    ])], { style: { paddingTop: 48, paddingBottom: 48 } }),
  },
  { id: 'pricing', name: 'Tarifs (2 formules)', category: 'Offre', modes: ['page', 'email'], build: (accent) => pricingRow(accent) },
  { id: 'faq', name: 'FAQ', category: 'Offre', modes: ['page', 'email'], build: (accent) => faqSection(accent) },
  { id: 'cta', name: 'Bandeau d’appel à l’action', category: 'Conversion', modes: ['page', 'email'], build: (accent) => ctaBand({ title: 'Prêt(e) à commencer ?', text: 'Rejoignez les 2 400 membres qui ont déjà sauté le pas.', cta: 'Je me lance', bg: accent }) },
  {
    id: 'optin-band', name: 'Formulaire d’inscription', category: 'Conversion', modes: ['page'],
    build: (accent) => section([H('Recevez nos conseils chaque semaine', 2, { align: 'center', fontSize: 32, mobileFontSize: 24 }), P('Une astuce actionnable par semaine, directement dans votre boîte mail.', { align: 'center', color: '#64748b' }), form('Je m’abonne', { buttonBg: accent })], { contentWidth: 560, style: { background: '#f8fafc' } }),
  },
  {
    id: 'countdown', name: 'Offre à durée limitée', category: 'Conversion', modes: ['page'],
    build: (accent) => section([H('L’offre se termine dans', 2, { align: 'center', color: '#ffffff', fontSize: 30 }), mk('countdown', { mode: 'evergreen', minutes: 60 * 24, showLabels: true, boxBg: 'rgba(255,255,255,0.14)', boxColor: '#ffffff', expiredText: 'L’offre est terminée.', style: { align: 'center' } }), btn('J’en profite', { bg: '#ffffff', textColor: accent })], { contentWidth: 760, style: { background: '#0f172a', paddingTop: 64, paddingBottom: 64 } }),
  },
  { id: 'footer', name: 'Pied de page', category: 'Pied de page', modes: ['page', 'email'], build: () => footerSection('MaMarque') },
];

/** Section templates adapted to the target (full-width sections are boxed in emails). */
export function buildSection(t: SectionTemplate, mode: 'page' | 'email', accent: string): Block {
  const b = t.build(accent);
  if (mode === 'email' && b.type === 'section') {
    b.fullWidth = false;
    b.style = { ...b.style, paddingTop: Math.min(48, b.style?.paddingTop ?? 48), paddingBottom: Math.min(48, b.style?.paddingBottom ?? 48) };
    b.minHeight = undefined;
  }
  if (mode === 'email') adaptForEmail([b]);
  return b;
}

/** Emails have no "next step": turn such buttons into links, drop page-only blocks. */
export function adaptForEmail(blocks: Block[]) {
  walk(blocks, (x) => {
    if (x.type === 'button' && x.action === 'next') {
      x.action = 'url';
      x.url = x.url || 'https://';
    }
    if (x.type === 'pricing' && x.action === 'next') {
      x.action = 'url';
      x.url = x.url || 'https://';
    }
    if (x.type === 'imageText' && x.buttonAction === 'next') {
      x.buttonAction = 'url';
      x.buttonUrl = x.buttonUrl || 'https://';
    }
    if (x.type === 'section') x.children = x.children.filter((c) => !['form', 'countdown', 'html'].includes(c.type));
    if (x.type === 'columns') x.columns.forEach((c) => (c.children = c.children.filter((k) => !['form', 'countdown', 'html'].includes(k.type))));
  });
  return blocks;
}

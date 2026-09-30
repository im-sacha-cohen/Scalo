import type { Block, BlockType, Column, ColumnsBlock, PageContent, StepType } from './types';
import { DEFAULT_EMAIL_SETTINGS, DEFAULT_SETTINGS } from './render';
import type { LegalPageKind } from './growth';
// library.ts only uses helpers from this module inside functions, so the import cycle is safe.
import { pageTemplateForStep } from './library';

export const uid = () => Math.random().toString(36).slice(2, 10);

export const BLOCK_LABELS: Record<BlockType, string> = {
  heading: 'Titre',
  text: 'Texte',
  list: 'Liste',
  image: 'Image',
  button: 'Bouton',
  form: 'Formulaire',
  video: 'Vidéo',
  spacer: 'Espace',
  divider: 'Séparateur',
  section: 'Section',
  columns: 'Colonnes',
  countdown: 'Compte à rebours',
  testimonial: 'Témoignage',
  pricing: 'Carte de prix',
  faq: 'FAQ',
  feature: 'Atout / icône',
  social: 'Réseaux sociaux',
  imageText: 'Image + texte',
  progress: 'Barre de progression',
  navbar: 'En-tête / logo',
  footer: 'Pied de page',
  html: 'HTML personnalisé',
  rating: 'Note (étoiles)',
  quote: 'Citation',
  checkout: 'Paiement',
  upsell: 'Offre en un clic',
};

/** Blocks available in the email builder (no forms, no scripts, no custom HTML). */
export const EMAIL_BLOCK_TYPES: BlockType[] = [
  'section', 'columns',
  'heading', 'text', 'list', 'image', 'button', 'video', 'spacer', 'divider',
  'navbar', 'imageText', 'feature', 'testimonial', 'pricing', 'faq', 'quote', 'rating', 'progress', 'social', 'footer',
];
export const PAGE_BLOCK_TYPES: BlockType[] = [
  'section', 'columns',
  'heading', 'text', 'list', 'image', 'button', 'form', 'video', 'spacer', 'divider',
  'navbar', 'imageText', 'feature', 'testimonial', 'pricing', 'faq', 'countdown', 'quote', 'rating', 'progress', 'social', 'footer', 'html',
  'checkout', 'upsell',
];

/** Container blocks (can hold other blocks). */
export const isContainer = (t: BlockType) => t === 'section' || t === 'columns';

export const COLUMN_PRESETS: { id: string; label: string; widths: number[] }[] = [
  { id: '50-50', label: '1/2 · 1/2', widths: [50, 50] },
  { id: '33-67', label: '1/3 · 2/3', widths: [33, 67] },
  { id: '67-33', label: '2/3 · 1/3', widths: [67, 33] },
  { id: '25-75', label: '1/4 · 3/4', widths: [25, 75] },
  { id: '75-25', label: '3/4 · 1/4', widths: [75, 25] },
  { id: '33-33-33', label: '3 × 1/3', widths: [33.33, 33.33, 33.34] },
  { id: '25-25-25-25', label: '4 × 1/4', widths: [25, 25, 25, 25] },
];

export const newColumn = (width: number, children: Block[] = []): Column => ({ id: uid(), width, children });

export function createColumns(widths: number[] = [50, 50], children: Block[][] = []): ColumnsBlock {
  return { id: uid(), type: 'columns', columns: widths.map((w, i) => newColumn(w, children[i] ?? [])), gap: 24, stackOnMobile: true };
}

export function createBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'heading': return { id, type, text: 'Votre titre accrocheur', level: 1, style: { align: 'center' } };
    case 'text': return { id, type, text: 'Écrivez votre texte ici. Double-cliquez pour le modifier directement sur la page.' };
    case 'list': return { id, type, items: ['Premier bénéfice', 'Deuxième bénéfice', 'Troisième bénéfice'], icon: 'check' };
    case 'image': return { id, type, src: '', alt: '', width: 100, style: { align: 'center' } };
    case 'button': return { id, type, label: 'Je veux en profiter', action: 'next', style: { align: 'center' } };
    case 'form': return {
      id, type, submitLabel: "Je m'inscris",
      fields: [
        { name: 'first_name', label: 'Votre prénom' },
        { name: 'email', label: 'Votre email', required: true },
      ],
    };
    case 'video': return { id, type, url: '' };
    case 'spacer': return { id, type, height: 32 };
    case 'divider': return { id, type };
    case 'section': return { id, type, children: [], style: { paddingTop: 56, paddingBottom: 56 } };
    case 'columns': return { ...createColumns([50, 50]), id };
    case 'countdown': return { id, type, mode: 'evergreen', minutes: 60 * 24, showLabels: true, expiredText: 'L’offre est terminée.', style: { align: 'center' } };
    case 'testimonial': return {
      id, type, quote: 'J’ai appliqué la méthode dès la première semaine et mes résultats ont doublé. Je recommande à 100 % !',
      name: 'Camille Martin', role: 'Coach bien-être', stars: 5, layout: 'card',
    };
    case 'pricing': return {
      id, type, title: 'Formule Pro', price: '97 €', period: '/ mois', description: 'Pour passer à la vitesse supérieure',
      features: ['Accès à toutes les formations', 'Communauté privée', 'Support prioritaire'],
      buttonLabel: 'Choisir cette offre', action: 'next', highlighted: true, badge: 'Populaire',
    };
    case 'faq': return {
      id, type, openFirst: true,
      items: [
        { q: 'À qui s’adresse cette offre ?', a: 'À toute personne qui souhaite lancer ou développer son activité en ligne, même en partant de zéro.' },
        { q: 'Combien de temps ai-je accès au contenu ?', a: 'L’accès est illimité : vous pouvez suivre le programme à votre rythme.' },
        { q: 'Et si cela ne me convient pas ?', a: 'Vous bénéficiez d’une garantie satisfait ou remboursé de 30 jours, sans justification.' },
      ],
    };
    case 'feature': return { id, type, icon: '🚀', title: 'Résultats rapides', text: 'Une méthode simple et éprouvée pour obtenir vos premiers résultats en quelques jours.', layout: 'top' };
    case 'social': return {
      id, type, variant: 'brand', size: 40, style: { align: 'center' },
      links: [
        { network: 'facebook', url: 'https://facebook.com/' },
        { network: 'instagram', url: 'https://instagram.com/' },
        { network: 'youtube', url: 'https://youtube.com/' },
      ],
    };
    case 'imageText': return {
      id, type, src: `https://picsum.photos/seed/${id}/800/600`, alt: '', imagePosition: 'left', imageWidth: 45,
      title: 'Un titre qui donne envie', text: 'Expliquez en quelques phrases le bénéfice principal de votre offre et pourquoi elle change tout.',
    };
    case 'progress': return { id, type, value: 70, label: 'Places réservées', height: 14 };
    case 'navbar': return {
      id, type, logoText: 'MaMarque',
      links: [{ label: 'Accueil', url: '#' }, { label: 'Offre', url: '#offre' }, { label: 'Contact', url: '#contact' }],
      ctaLabel: 'Commencer', ctaUrl: '#',
      style: { paddingTop: 16, paddingBottom: 16 },
    };
    case 'footer': return {
      id, type, text: 'Une question ? Écrivez-nous à contact@mamarque.fr',
      links: [{ label: 'Mentions légales', url: '#' }, { label: 'Confidentialité', url: '#' }],
      copyright: `© ${new Date().getFullYear()} MaMarque. Tous droits réservés.`,
      style: { align: 'center', paddingTop: 32, paddingBottom: 32 },
    };
    case 'html': return { id, type, html: '' };
    case 'rating': return { id, type, value: 5, max: 5, caption: 'Note moyenne 4,9/5 sur 320 avis', style: { align: 'center' } };
    case 'checkout': return { id, type, submitLabel: 'Commander', askName: true, showSummary: true, secureNote: 'Paiement sécurisé par Stripe' };
    case 'upsell': return { id, type, acceptLabel: 'Oui, j’ajoute cette offre à ma commande', declineLabel: 'Non merci, je passe cette offre', note: 'Un seul clic : votre moyen de paiement est déjà enregistré.', style: { align: 'center' } };
    case 'quote': return { id, type, text: 'Le meilleur moment pour commencer, c’était hier. Le deuxième meilleur moment, c’est maintenant.', author: 'Proverbe' };
  }
}

/** Default page for a new step: uses the gallery templates. */
export function stepTemplate(type: StepType): PageContent {
  return pageTemplateForStep(type);
}

export function emailTemplate(): PageContent {
  const t = (text: string): Block => ({ id: uid(), type: 'text', text });
  return {
    settings: { ...DEFAULT_EMAIL_SETTINGS },
    blocks: [t('Bonjour {{first_name}},'), t('Votre message ici.'), t('À bientôt !')],
  };
}

export const FUNNEL_TEMPLATES: Record<string, { label: string; description: string; steps: { name: string; type: StepType }[] }> = {
  optin: {
    label: 'Capture d’emails',
    description: 'Page de capture + page de remerciement',
    steps: [{ name: 'Inscription', type: 'optin' }, { name: 'Merci', type: 'thankyou' }],
  },
  sales: {
    label: 'Tunnel de vente',
    description: 'Capture, page de vente, remerciement',
    steps: [{ name: 'Inscription', type: 'optin' }, { name: 'Offre', type: 'sales' }, { name: 'Merci', type: 'thankyou' }],
  },
  blank: { label: 'Vierge', description: 'Une page vide', steps: [{ name: 'Page 1', type: 'custom' }] },
};

// ---------- legal pages (funnels growth) ----------

/** Marker left in the legal templates for what the account settings cannot fill in. */
export const TODO_MARK = '[À compléter]';

export const LEGAL_PAGES: Record<LegalPageKind, { name: string; slug: string; label: string }> = {
  mentions: { name: 'Mentions légales', slug: 'mentions-legales', label: 'Mentions légales' },
  privacy: { name: 'Politique de confidentialité', slug: 'confidentialite', label: 'Confidentialité' },
  cgv: { name: 'Conditions générales de vente', slug: 'cgv', label: 'CGV' },
};

export interface LegalVars {
  company?: string; // sender name / company name
  address?: string; // company address
  email?: string;   // contact email
  site?: string;    // site / funnel name
}

/**
 * Ready-made French legal page, pre-filled from the account settings. Everything the settings cannot provide is left
 * as a visible `[À compléter …]` marker. A starting point, not legal advice.
 */
export function legalPageTemplate(kind: LegalPageKind, v: LegalVars = {}): PageContent {
  const todo = (what: string) => `[À compléter : ${what}]`;
  const company = v.company?.trim() || todo('raison sociale ou nom de l’éditeur');
  const address = v.address?.trim().replace(/\s*\n\s*/g, ', ') || todo('adresse du siège');
  const email = v.email?.trim() || todo('email de contact');
  const site = v.site?.trim() || 'ce site';
  const h = (text: string, level: 1 | 2 = 2): Block => ({ id: uid(), type: 'heading', level, text, style: { align: 'left', paddingTop: level === 1 ? 32 : 20, paddingBottom: 4 } });
  const p = (text: string): Block => ({ id: uid(), type: 'text', text, style: { paddingTop: 4, paddingBottom: 4 } });
  const updated = `*Dernière mise à jour : ${todo('date')}*`;
  const blocks: Block[] = [];
  if (kind === 'mentions') {
    blocks.push(
      h('Mentions légales', 1),
      p(updated),
      h('Éditeur du site'),
      p(`Le site ${site} est édité par **${company}**, ${todo('forme juridique et capital social')}, dont le siège est situé ${address}.\nImmatriculation : ${todo('RCS / RNE et numéro SIREN')}\nNuméro de TVA intracommunautaire : ${todo('numéro de TVA ou « non applicable »')}\nEmail : ${email}\nTéléphone : ${todo('numéro de téléphone')}`),
      p(`Directeur ou directrice de la publication : ${todo('nom du responsable de la publication')}`),
      h('Hébergement'),
      p(`Le site est hébergé par ${todo('nom, adresse et téléphone de l’hébergeur')}.`),
      h('Propriété intellectuelle'),
      p(`L’ensemble des contenus de ce site (textes, images, vidéos, logos) est la propriété de ${company} ou de ses partenaires. Toute reproduction ou représentation, totale ou partielle, sans autorisation écrite préalable est interdite.`),
      h('Données personnelles'),
      p(`Les données collectées via les formulaires de ce site sont traitées conformément à notre politique de confidentialité. Pour exercer vos droits, écrivez à ${email}.`),
      h('Contact'),
      p(`Pour toute question relative au site : ${email}.`),
    );
  } else if (kind === 'privacy') {
    blocks.push(
      h('Politique de confidentialité', 1),
      p(updated),
      p(`Cette politique explique comment **${company}** (« nous »), responsable du traitement, collecte et utilise vos données personnelles lorsque vous utilisez ${site}.`),
      h('Données collectées'),
      p('Nous collectons les données que vous saisissez dans nos formulaires (adresse email, prénom, nom, téléphone le cas échéant), ainsi que des données de navigation : pages consultées, provenance de la visite (paramètres UTM, site référent) et identifiant de visite stocké dans un cookie.'),
      h('Finalités et bases légales'),
      p(`- Envoi des contenus demandés et de notre newsletter : votre consentement, donné lors de l’inscription.\n- Mesure d’audience et amélioration du site : notre intérêt légitime, ou votre consentement pour les cookies tiers.\n- Publicité et mesure des campagnes (${todo('outils utilisés, ex. Meta, Google')}) : votre consentement.\n- Gestion des commandes, le cas échéant : l’exécution du contrat.`),
      h('Destinataires'),
      p(`Vos données sont destinées à ${company} et à ses sous-traitants techniques (hébergement, envoi d’emails : ${todo('prestataires')}). Elles ne sont jamais vendues. ${todo('préciser les éventuels transferts hors de l’Union européenne et leurs garanties')}.`),
      h('Durée de conservation'),
      p(`Les données des contacts sont conservées jusqu’à votre désinscription, puis ${todo('durée, ex. 3 ans à compter du dernier contact')}. Les cookies sont conservés au maximum 13 mois et votre choix concernant les cookies 6 mois.`),
      h('Cookies'),
      p('Un cookie technique mémorise votre visite et votre choix concernant les cookies. Les cookies de mesure et de publicité tiers ne sont déposés qu’après votre accord, que vous pouvez refuser ou retirer à tout moment.'),
      h('Vos droits'),
      p(`Vous disposez d’un droit d’accès, de rectification, d’effacement, d’opposition, de limitation et de portabilité de vos données, et vous pouvez retirer votre consentement à tout moment (lien de désinscription présent dans chaque email). Pour exercer vos droits : ${email}. Vous pouvez également introduire une réclamation auprès de la CNIL (www.cnil.fr).`),
      h('Contact'),
      p(`${company}, ${address} — ${email}`),
    );
  } else {
    blocks.push(
      h('Conditions générales de vente', 1),
      p(updated),
      h('Article 1 — Objet'),
      p(`Les présentes conditions générales de vente (CGV) régissent les ventes des produits et services proposés par **${company}**, ${address}, ${todo('immatriculation (RCS / RNE, SIREN)')}, sur ${site}.`),
      h('Article 2 — Produits et services'),
      p(`${todo('description des produits ou services vendus (formation en ligne, accompagnement, produits numériques…)')}. Les caractéristiques essentielles sont présentées sur la page de chaque offre.`),
      h('Article 3 — Prix'),
      p(`Les prix sont indiqués en euros, ${todo('TTC / HT, TVA non applicable art. 293 B du CGI le cas échéant')}. ${company} se réserve le droit de modifier ses prix à tout moment ; le prix appliqué est celui en vigueur au moment de la commande.`),
      h('Article 4 — Commande et paiement'),
      p(`La commande est validée après paiement ${todo('moyens de paiement acceptés, paiement en plusieurs fois')}. Une confirmation est envoyée par email.`),
      h('Article 5 — Livraison et accès'),
      p(`${todo('modalités et délais de livraison ou d’accès aux contenus numériques')}.`),
      h('Article 6 — Droit de rétractation'),
      p(`Conformément à l’article L221-18 du Code de la consommation, le client consommateur dispose d’un délai de 14 jours pour se rétracter, en écrivant à ${email}. Pour les contenus numériques fournis immédiatement, le client renonce expressément à ce droit en demandant l’accès avant la fin du délai (article L221-28). ${todo('garantie commerciale éventuelle, ex. satisfait ou remboursé 30 jours')}.`),
      h('Article 7 — Responsabilité et garanties'),
      p(`${company} est tenu de la garantie légale de conformité et de la garantie des vices cachés dans les conditions prévues par la loi. ${todo('limitations de responsabilité propres à votre activité')}.`),
      h('Article 8 — Données personnelles'),
      p('Les données collectées lors de la commande sont traitées conformément à notre politique de confidentialité.'),
      h('Article 9 — Médiation et litiges'),
      p(`En cas de litige, le client peut recourir gratuitement au médiateur de la consommation : ${todo('nom et coordonnées du médiateur')}. Les présentes CGV sont soumises au droit français.`),
      h('Contact'),
      p(`Service client : ${email}`),
    );
  }
  return { settings: { ...DEFAULT_SETTINGS, maxWidth: 760 }, blocks };
}


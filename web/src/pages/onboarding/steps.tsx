// The four steps of the welcome flow. Each one is a plain form: Enter continues, every control is reachable with
// the keyboard, and nothing is mandatory beyond what the next step really needs.
import { useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRight,
  ArrowRightLeft,
  ArrowUpRight,
  AtSign,
  Check,
  Copy,
  GraduationCap,
  LayoutTemplate,
  PencilRuler,
  ShoppingBag,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  FUNNEL_TEMPLATES,
  ONBOARDING_TEMPLATE,
  renderPageDocument,
  stepTemplate,
  type OnboardingFunnel,
  type OnboardingGoal,
  type PageContent,
} from '@scalo/shared';
import { api } from '../../lib/api';
import { aiApi, waitForGeneration } from '../../lib/ai-api';
import { copyText } from '../../lib/hooks';
import { initials, STEP_TYPE_LABELS } from '../../lib/format';
import { Button, cx, Field, Input, Kbd, Textarea } from '../../components/ui';
import { BrowserFrame, LiveDot, PageThumb, StepHead } from './parts';

type HeadRef = Ref<HTMLHeadingElement>;
const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie.dupont@exemple.fr', phone: '' };
const render = (content: PageContent, title: string) => renderPageDocument(content, { title, nextUrl: '#', formAction: '#', vars: EXAMPLE_VARS });
const prettyUrl = (url: string) => url.replace(/^https?:\/\//, '');

function ErrorNote({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3.5 py-2.5 text-sm text-rose-700">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {children}
    </p>
  );
}

// ---------------------------------------------------------------- 1. goal

const GOALS: { id: OnboardingGoal; icon: LucideIcon; title: string; desc: string; result: string }[] = [
  { id: 'leads', icon: AtSign, title: 'Capturer des emails', desc: 'Offrir un guide, une remise ou une newsletter en échange d’une adresse.', result: 'Page de capture + remerciement' },
  { id: 'sell', icon: ShoppingBag, title: 'Vendre un produit ou un service', desc: 'Présenter une offre et encaisser par carte, sur votre compte Stripe.', result: 'Capture, page de vente, remerciement' },
  { id: 'course', icon: GraduationCap, title: 'Vendre une formation', desc: 'Héberger vos leçons et ouvrir l’accès à vos élèves après l’achat.', result: 'Tunnel de vente + espace membres' },
  { id: 'migrate', icon: ArrowRightLeft, title: 'Migrer depuis un autre outil', desc: 'Reprendre vos contacts et vos tags depuis systeme.io ou un fichier CSV.', result: 'Import guidé, puis votre première page' },
];

export function GoalStep({ value, onChange, onNext, dir, headingRef }: { value: OnboardingGoal | null; onChange: (g: OnboardingGoal) => void; onNext: () => void; dir: 'forward' | 'back'; headingRef: HeadRef }) {
  // 1–4 pick an answer without leaving the keyboard's home row
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'radio'))) return;
      const g = GOALS[Number(e.key) - 1];
      if (g) {
        onChange(g.id);
        document.getElementById(`goal-${g.id}`)?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChange]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value) onNext();
  };

  return (
    <form onSubmit={submit} className="onb-step max-w-[760px]" data-dir={dir}>
      <StepHead
        n={1}
        eyebrow="Objectif"
        headingRef={headingRef}
        title="Que voulez-vous faire en premier&nbsp;?"
        lead="Votre réponse choisit le modèle de votre première page et l’ordre de votre liste de démarrage. Le reste de Scalo reste à portée de main."
      />
      <fieldset className="mt-8">
        <legend className="sr-only">Votre objectif</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {GOALS.map((g, i) => {
            const on = value === g.id;
            return (
              <label
                key={g.id}
                className={cx(
                  'onb-motion group relative flex cursor-pointer gap-4 rounded-2xl border p-4 transition duration-200 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-500/25 sm:p-5',
                  on ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-float',
                )}
              >
                <input id={`goal-${g.id}`} type="radio" name="goal" value={g.id} checked={on} onChange={() => onChange(g.id)} className="sr-only" />
                <span className={cx('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl transition-colors', on ? 'bg-brand-500 text-white' : 'bg-brand-50 text-brand-600 group-hover:bg-brand-100')}>
                  <g.icon size={20} strokeWidth={1.9} />
                </span>
                <span className="min-w-0 flex-1 pr-7">
                  <span className="block font-display text-[16px] leading-snug font-bold tracking-[-0.01em] text-ink">{g.title}</span>
                  <span className="mt-1 block text-sm leading-snug text-slate-600">{g.desc}</span>
                  <span className={cx('mt-3 block font-mono text-[11px] leading-snug', on ? 'text-brand-700' : 'text-slate-500')}>→ {g.result}</span>
                </span>
                <span className="absolute top-4 right-4" aria-hidden="true">
                  {on ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand-500 text-white">
                      <Check size={12} strokeWidth={3} />
                    </span>
                  ) : (
                    <span className="hidden lg:block">
                      <Kbd>{i + 1}</Kbd>
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button type="submit" size="lg" iconRight={ArrowRight} disabled={!value}>
          Continuer
        </Button>
        <p className="hidden items-center gap-1.5 text-xs text-slate-500 lg:flex">
          <Kbd>1</Kbd>–<Kbd>4</Kbd> pour choisir, <Kbd>Entrée</Kbd> pour continuer
        </p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 2. business

export interface BusinessDraft {
  name: string;
  email: string;
  address: string;
}

export function BusinessStep({
  draft,
  onChange,
  onNext,
  saving,
  error,
  dir,
  headingRef,
}: {
  draft: BusinessDraft;
  onChange: (d: BusinessDraft) => void;
  onNext: () => void;
  saving: boolean;
  error: string | null;
  dir: 'forward' | 'back';
  headingRef: HeadRef;
}) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onNext();
  };
  const name = draft.name.trim();
  const address = draft.address.trim();
  return (
    <div className="onb-step grid grid-cols-[minmax(0,1fr)] max-w-[1040px] items-start gap-x-14 gap-y-10 xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)]" data-dir={dir}>
      <form onSubmit={submit} className="space-y-5">
        <StepHead
          n={2}
          eyebrow="Activité"
          headingRef={headingRef}
          title="Qui écrit à vos contacts&nbsp;?"
          lead="Ces informations signent chacun de vos emails. Elles s’enregistrent dans vos paramètres, modifiables à tout moment."
        />
        <div className="space-y-4 pt-3">
          <Field label="Nom de votre activité" hint="Le nom affiché comme expéditeur : le vôtre, ou celui de votre marque.">
            <Input required maxLength={120} autoComplete="organization" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="Atelier Lumière" className="h-11 text-[15px]" />
          </Field>
          <Field label="Email d’expéditeur" hint="Vos contacts y répondent. Prérempli avec l’adresse de votre compte.">
            <Input required type="email" maxLength={254} autoComplete="email" value={draft.email} onChange={(e) => onChange({ ...draft, email: e.target.value })} placeholder="bonjour@votre-domaine.fr" className="h-11 text-[15px]" />
          </Field>
          <Field
            label={
              <>
                Adresse postale <span className="font-normal text-slate-400">— vous pourrez la compléter plus tard</span>
              </>
            }
            hint="La loi impose une adresse postale en pied de tout email commercial : Scalo l’ajoute pour vous."
          >
            <Textarea rows={2} maxLength={500} autoComplete="street-address" value={draft.address} onChange={(e) => onChange({ ...draft, address: e.target.value })} placeholder="12 rue des Lilas, 69003 Lyon, France" className="text-[15px]" />
          </Field>
        </div>
        <ErrorNote>{error}</ErrorNote>
        <Button type="submit" size="lg" iconRight={ArrowRight} loading={saving}>
          Continuer
        </Button>
      </form>

      {/* live picture of what a contact receives: the form above writes into it */}
      <aside aria-hidden="true" className="hidden xl:block xl:pt-[72px]">
        <p className="mb-3 font-mono text-[11px] tracking-[0.12em] text-slate-400 uppercase">Dans la boîte de réception de vos contacts</p>
        <div className="rounded-2xl border border-slate-200 bg-white shadow-float">
          <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-4">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold text-white">{initials(name || 'Vous')}</span>
            <span className="min-w-0 flex-1">
              <span className={cx('block truncate text-sm font-semibold', name ? 'text-ink' : 'text-slate-400')}>{name || 'Nom de votre activité'}</span>
              <span className="block truncate font-mono text-[11px] text-slate-500">{draft.email.trim() || 'votre@email.fr'}</span>
            </span>
            <span className="text-xs text-slate-400">09:41</span>
          </div>
          <div className="px-5 py-5">
            <p className="text-[15px] font-semibold text-ink">Bienvenue ! Voici votre guide</p>
            <div className="mt-4 space-y-2">
              <div className="h-2 w-11/12 rounded-full bg-slate-100" />
              <div className="h-2 w-full rounded-full bg-slate-100" />
              <div className="h-2 w-8/12 rounded-full bg-slate-100" />
            </div>
            <div className="mt-5 h-8 w-36 rounded-full bg-brand-100" />
          </div>
          <div className="rounded-b-2xl border-t border-slate-100 bg-slate-50 px-5 py-4 text-center text-xs leading-relaxed text-slate-500">
            <p className={cx('mx-auto max-w-[36ch] whitespace-pre-line rounded-lg px-2 py-1 transition-colors', address ? 'text-slate-600' : 'border border-dashed border-brand-300 text-brand-600')}>
              {address || 'Votre adresse postale s’affichera ici'}
            </p>
            <p className="mt-1.5 underline decoration-slate-300 underline-offset-2">Se désinscrire</p>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- 3. first funnel

const FUNNEL_SUFFIX: Record<OnboardingGoal, string> = { leads: 'Inscription', sell: 'Offre', course: 'Formation', migrate: 'Inscription' };
const FUNNEL_LEAD: Record<OnboardingGoal, string> = {
  leads: 'Une page qui échange un contenu contre une adresse email, puis une page de remerciement. Les textes sont des exemples : vous les remplacerez à la souris.',
  sell: 'Une page de capture, une page de vente, une page de remerciement. Vous brancherez le paiement depuis votre liste de démarrage.',
  course: 'Le tunnel qui vend votre formation : capture, page de vente, remerciement. La formation elle-même se crée ensuite, dans « Formations ».',
  migrate: 'Commencez par rapatrier vos données, ou mettez tout de suite une page en ligne : les deux se font indépendamment.',
};
const AI_MESSAGES = ['Lecture de votre offre', 'Rédaction des pages', 'Mise en page et formulaire'];

export function FunnelStep({
  goal,
  business,
  aiReady,
  importStarted,
  onCreated,
  dir,
  headingRef,
}: {
  goal: OnboardingGoal;
  business: string;
  aiReady: boolean;
  importStarted: boolean;
  onCreated: (funnelId: number, notice?: string) => Promise<void>;
  dir: 'forward' | 'back';
  headingRef: HeadRef;
}) {
  const navigate = useNavigate();
  const tplKey = ONBOARDING_TEMPLATE[goal];
  const tpl = FUNNEL_TEMPLATES[tplKey]!;
  const previews = useMemo(() => tpl.steps.map((s) => ({ ...s, html: render(stepTemplate(s.type), s.name) })), [tpl]);
  const [shown, setShown] = useState(0);
  const [mode, setMode] = useState<'template' | 'ai'>('template');
  const [offer, setOffer] = useState('');
  const [busy, setBusy] = useState<null | 'template' | 'ai'>(null);
  const [error, setError] = useState<string | null>(null);
  const [aiTick, setAiTick] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    if (busy !== 'ai') return;
    setAiTick(0);
    const t = setInterval(() => setAiTick((n) => Math.min(n + 1, AI_MESSAGES.length - 1)), 6000);
    return () => clearInterval(t);
  }, [busy]);

  const funnelName = `${business.trim().slice(0, 80) || 'Mon activité'} — ${FUNNEL_SUFFIX[goal]}`;
  const address = `${window.location.host}/p/…`;

  const fromTemplate = async (notice?: string) => {
    setBusy('template');
    setError(null);
    try {
      const f = await api.createFunnel({ name: funnelName, template: tplKey });
      await onCreated(f.id, notice);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const fromAi = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy('ai');
    setError(null);
    try {
      const { id } = await aiApi.generateFunnel({ offer: offer.trim(), goal: tplKey === 'sales' ? 'vente' : 'capture' });
      const g = await waitForGeneration(id, ctrl.signal);
      if (!g.result?.funnel_id) throw new Error('aucun tunnel n’a été créé');
      await onCreated(g.result.funnel_id);
    } catch (e) {
      if (ctrl.signal.aborted) return; // the user chose the template meanwhile
      // never a dead end: the template always works
      await fromTemplate(`L’IA n’a pas pu rédiger votre tunnel (${(e as Error).message.replace(/\.$/, '')}). Nous l’avons créé à partir du modèle : tout reste modifiable dans l’éditeur.`);
    }
  };

  const useTemplateInstead = () => {
    abort.current?.abort();
    void fromTemplate();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'ai') void fromAi();
    else void fromTemplate();
  };

  const offerOk = offer.trim().length >= 10;

  return (
    <div className="onb-step grid grid-cols-[minmax(0,1fr)] max-w-[1120px] items-start gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,430px)_minmax(0,1fr)]" data-dir={dir}>
      <form onSubmit={submit} className="space-y-6">
        <StepHead n={3} eyebrow="Premier tunnel" headingRef={headingRef} title="Votre première page, en ligne en un clic." lead={FUNNEL_LEAD[goal]} />

        {goal === 'migrate' && (
          <div className="rounded-2xl bg-ink p-5 text-white">
            <p className="flex items-center gap-2 font-display text-[15px] font-bold">
              <ArrowRightLeft size={16} className="text-lime-400" />
              {importStarted ? 'Votre import est lancé' : 'Rapatrier vos contacts et vos tags'}
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-brand-200">
              {importStarted
                ? 'Il tourne en arrière-plan et vous le retrouverez dans « Migrer ». Il ne vous reste qu’à mettre une page en ligne.'
                : 'Depuis systeme.io ou un fichier CSV : tags, champs et abonnements sont repris. Cette mise en route vous attendra ici, à la même étape.'}
            </p>
            <button
              type="button"
              onClick={() => navigate('/migrate')}
              className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-lime-400 px-4 text-sm font-semibold text-ink outline-none transition-colors hover:bg-[#d4fa5c] focus-visible:ring-4 focus-visible:ring-white/30"
            >
              {importStarted ? 'Suivre l’import' : 'Ouvrir la migration'} <ArrowRight size={15} />
            </button>
          </div>
        )}

        {busy === 'ai' ? (
          <div role="status" aria-live="polite" className="onb-fade rounded-2xl border border-brand-200 bg-brand-50 p-5">
            <p className="flex items-center gap-2 font-display text-[15px] font-bold text-ink">
              <Sparkles size={16} className="text-brand-500" /> L’IA rédige votre tunnel
            </p>
            <ol className="mt-4 space-y-2">
              {AI_MESSAGES.map((m, i) => (
                <li key={m} className="flex items-center gap-3 text-sm" style={{ marginLeft: i * 14 }}>
                  <span
                    className={cx('h-2.5 w-9 rounded-full', i < aiTick ? 'bg-brand-500' : i === aiTick ? 'onb-build bg-brand-500' : 'bg-brand-200')}
                    style={i === aiTick ? undefined : { animationDelay: `${i * 0.3}s` }}
                  />
                  <span className={cx(i <= aiTick ? 'font-medium text-ink' : 'text-slate-500')}>
                    {m}
                    {i === aiTick ? '…' : ''}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-sm text-slate-600">Comptez moins d’une minute. Vous pouvez aussi ne pas attendre.</p>
            <Button variant="secondary" size="sm" className="mt-3" icon={LayoutTemplate} onClick={useTemplateInstead}>
              Utiliser le modèle à la place
            </Button>
          </div>
        ) : (
          <>
            {aiReady && (
              <div role="radiogroup" aria-label="Comment créer le tunnel" className="inline-flex rounded-full bg-slate-100 p-1">
                {(
                  [
                    ['template', 'Partir du modèle', LayoutTemplate],
                    ['ai', 'Rédiger avec l’IA', Sparkles],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={mode === id}
                    onClick={() => setMode(id)}
                    className={cx(
                      'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold outline-none transition-colors focus-visible:ring-4 focus-visible:ring-brand-500/25',
                      mode === id ? 'bg-white text-ink shadow-card' : 'text-slate-600 hover:text-ink',
                    )}
                  >
                    <Icon size={14} /> {label}
                  </button>
                ))}
              </div>
            )}

            {mode === 'ai' && aiReady ? (
              <Field label="Décrivez votre offre en une phrase" hint="L’IA écrit les titres, les textes et le formulaire à partir de cette phrase. 10 caractères au minimum.">
                <Textarea
                  autoFocus
                  rows={3}
                  maxLength={2000}
                  value={offer}
                  onChange={(e) => setOffer(e.target.value)}
                  placeholder="Un guide PDF gratuit pour aider les photographes indépendants à trouver leurs dix premiers clients."
                  className="text-[15px]"
                />
              </Field>
            ) : (
              <div className="rounded-2xl border border-slate-200 p-5">
                <p className="font-mono text-[11px] tracking-[0.12em] text-slate-400 uppercase">Modèle choisi pour vous</p>
                <p className="mt-1.5 font-display text-lg font-bold tracking-[-0.01em] text-ink">{tpl.label}</p>
                {/* the pages of the funnel, as steps: selecting one shows it in the preview */}
                <ol className="mt-4 space-y-1.5">
                  {previews.map((s, i) => (
                    <li key={s.name} style={{ marginLeft: i * 18 }}>
                      <button
                        type="button"
                        onClick={() => setShown(i)}
                        aria-pressed={shown === i}
                        className={cx(
                          'inline-flex h-9 items-center gap-2.5 rounded-full py-1 pr-4 pl-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-4 focus-visible:ring-brand-500/25',
                          shown === i ? 'bg-brand-500 text-white' : 'bg-brand-50 text-brand-800 hover:bg-brand-100',
                        )}
                      >
                        <span className={cx('flex h-6 w-6 items-center justify-center rounded-full font-mono text-[11px]', shown === i ? 'bg-white/15' : 'bg-white')}>{i + 1}</span>
                        {s.name}
                        <span className={cx('text-xs font-normal', shown === i ? 'text-brand-100' : 'text-slate-500')}>{STEP_TYPE_LABELS[s.type] ?? ''}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            <ErrorNote>{error}</ErrorNote>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button type="submit" size="lg" icon={mode === 'ai' && aiReady ? Sparkles : undefined} iconRight={ArrowRight} loading={busy === 'template'} disabled={mode === 'ai' && aiReady && !offerOk}>
                {mode === 'ai' && aiReady ? 'Rédiger et mettre en ligne' : 'Créer et mettre en ligne'}
              </Button>
              <p className="text-xs text-slate-500">Gratuit, modifiable et supprimable à tout moment.</p>
            </div>
          </>
        )}
      </form>

      <aside className="xl:pt-2">
        <BrowserFrame address={address}>
          <PageThumb key={shown} html={previews[shown]!.html} className="onb-fade aspect-[16/11]" />
        </BrowserFrame>
        <p className="mt-3 text-center text-xs text-slate-500">
          Aperçu réel du modèle — page « {previews[shown]!.name} » ({shown + 1} sur {previews.length})
        </p>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------- 4. live

export function LiveStep({
  funnel,
  notice,
  remaining,
  finishing,
  onFinish,
  headingRef,
}: {
  funnel: OnboardingFunnel;
  notice: string | null;
  remaining: number;
  finishing: string | null;
  onFinish: (to: string) => void;
  headingRef: HeadRef;
}) {
  const url = `${window.location.origin}/p/${funnel.slug}`;
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .funnel(funnel.id)
      .then((f) => {
        const first = f.steps?.[0];
        if (alive && first) setHtml(render(first.content, first.name));
      })
      .catch(() => undefined); // the preview is a bonus: the address above is what matters
    return () => {
      alive = false;
    };
  }, [funnel.id]);

  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };
  const editor = funnel.step_id ? `/funnels/${funnel.id}/steps/${funnel.step_id}/edit` : `/funnels/${funnel.id}`;

  return (
    <div className="onb-step grid grid-cols-[minmax(0,1fr)] max-w-[1120px] items-start gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]" data-dir="forward">
      <div className="space-y-6">
        <div>
          {/* the celebration: the lime pill of the logo, reached */}
          <p className="onb-pill mb-5 inline-flex items-center gap-2.5 rounded-full bg-ink py-1.5 pr-4 pl-1.5 text-sm font-semibold text-white">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-lime-400">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path className="onb-check" d="M3 8.5l3.2 3.2L13 4.8" stroke="#0E0B2B" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            Publié à l’instant
          </p>
          <StepHead
            n={4}
            eyebrow="En ligne"
            headingRef={headingRef}
            title="Votre page est en ligne."
            lead="Elle a sa propre adresse. Partagez-la : chaque visite et chaque inscription s’afficheront dans votre tableau de bord."
          />
        </div>

        {notice && (
          <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {notice}
          </p>
        )}

        <div>
          <p id="live-url-label" className="mb-1.5 text-sm font-medium text-slate-700">
            Adresse publique de votre page
          </p>
          <div className="flex items-center gap-2 rounded-2xl border border-brand-200 bg-brand-50 p-1.5 pl-4">
            <LiveDot />
            <a href={url} target="_blank" rel="noreferrer" aria-labelledby="live-url-label" className="min-w-0 flex-1 truncate rounded font-mono text-[13px] text-ink outline-none hover:text-brand-700 hover:underline focus-visible:ring-4 focus-visible:ring-brand-500/25 sm:text-sm">
              {prettyUrl(url)}
            </a>
            <Button variant={copied ? 'dark' : 'secondary'} size="sm" icon={copied ? Check : Copy} onClick={copy} className="min-w-[94px]">
              {copied ? 'Copié' : 'Copier'}
            </Button>
          </div>
          <p className="sr-only" role="status" aria-live="polite">
            {copied ? 'Adresse copiée dans le presse-papiers' : ''}
          </p>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-11 items-center gap-2 rounded-full bg-brand-500 px-6 text-base font-semibold text-white shadow-xs outline-none transition-colors hover:bg-brand-600 focus-visible:ring-4 focus-visible:ring-brand-500/40"
          >
            Voir ma page <ArrowUpRight size={18} />
            <span className="sr-only">(nouvel onglet)</span>
          </a>
          <Button variant="secondary" size="lg" icon={PencilRuler} loading={finishing === editor} disabled={!!finishing} onClick={() => onFinish(editor)}>
            Personnaliser dans l’éditeur
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-slate-200 pt-6">
          <p className="max-w-[34ch] text-sm leading-snug text-slate-600">
            {remaining > 0 ? (
              <>
                Et ensuite ? Votre liste de démarrage vous attend : <strong className="font-semibold text-ink">{remaining === 1 ? 'une étape' : `${remaining} étapes`}</strong> pour tout mettre en place.
              </>
            ) : (
              'Tout est en place. Votre tableau de bord vous attend.'
            )}
          </p>
          <Button variant="dark" size="lg" iconRight={ArrowRight} loading={finishing === '/dashboard'} disabled={!!finishing} onClick={() => onFinish('/dashboard')}>
            Aller au tableau de bord
          </Button>
        </div>
      </div>

      <aside className="xl:pt-2">
        <BrowserFrame address={prettyUrl(url)} live>
          {html ? <PageThumb html={html} className="onb-fade aspect-[16/11]" /> : <div className="aspect-[16/11] animate-pulse bg-slate-100" />}
        </BrowserFrame>
        <p className="mt-3 text-center text-xs text-slate-500">« {funnel.name} » — votre page telle que vos visiteurs la voient</p>
      </aside>
    </div>
  );
}

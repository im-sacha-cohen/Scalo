// "Générer avec l’IA": a button + brief dialog that creates a funnel, a campaign (email sequence) or a newsletter draft
// with Claude, then opens what was created. The generation runs on the server; the dialog polls its state.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { KeyRound, Sparkles } from 'lucide-react';
import { KITS } from '@scalo/shared';
import { Button, Field, Input, Select, Spinner, Textarea, cx, type ButtonProps } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useLoad } from '../../lib/hooks';
import { AI_GOAL_LABELS, AI_LANGUAGE_LABELS, AI_TONE_LABELS, aiApi, waitForGeneration, type AiGoal, type AiLanguage, type AiTone } from '../../lib/ai-api';

type Kind = 'funnel' | 'campaign' | 'newsletter';

const COPY: Record<Kind, { title: string; description: string; offerLabel: string; offerPlaceholder: string; submit: string; progress: string }> = {
  funnel: {
    title: 'Générer un tunnel avec l’IA',
    description: 'Décrivez votre offre : l’IA rédige les pages (capture, vente, remerciement) avec les blocs de l’éditeur. Vous pourrez tout modifier.',
    offerLabel: 'Votre offre',
    offerPlaceholder: 'ex. Un guide PDF gratuit « 10 recettes végétariennes en 15 minutes », puis un programme vidéo de 4 semaines à 97 €.',
    submit: 'Générer le tunnel',
    progress: 'Rédaction des pages du tunnel…',
  },
  campaign: {
    title: 'Générer une campagne avec l’IA',
    description: 'L’IA rédige une séquence d’emails avec leurs délais. La campagne est créée sans déclencheur : rien n’est envoyé tant que vous ne l’activez pas.',
    offerLabel: 'Objectif de la séquence',
    offerPlaceholder: 'ex. Accueillir les nouveaux inscrits au guide gratuit, leur apporter 3 conseils puis présenter le programme complet.',
    submit: 'Générer la campagne',
    progress: 'Rédaction de la séquence d’emails…',
  },
  newsletter: {
    title: 'Générer une newsletter avec l’IA',
    description: 'L’IA rédige un brouillon de newsletter (objet, aperçu, texte). Rien n’est envoyé : relisez puis envoyez quand vous êtes prêt.',
    offerLabel: 'Sujet de la newsletter',
    offerPlaceholder: 'ex. Annonce de la nouvelle formation de printemps, ouverture des inscriptions lundi, 20 places.',
    submit: 'Générer la newsletter',
    progress: 'Rédaction de la newsletter…',
  },
};

/** Explains how to configure a key (shown instead of the form when no key is available). */
export function AiNotConfigured({ className }: { className?: string }) {
  return (
    <div className={cx('rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900', className)}>
      <p className="flex items-center gap-2 font-semibold">
        <KeyRound size={15} /> Aucune clé API Claude configurée
      </p>
      <p className="mt-1.5 text-amber-800">
        Les fonctions IA utilisent votre propre clé API Anthropic (facturée par Anthropic selon votre usage). Créez une clé sur console.anthropic.com, puis collez-la dans{' '}
        <Link to="/settings#ia" className="font-semibold underline">
          Paramètres → IA
        </Link>
        .
      </p>
    </div>
  );
}

export function AiGenerateButton({ kind, label = 'Générer avec l’IA', ...button }: { kind: Kind; label?: string } & Omit<ButtonProps, 'onClick' | 'children'>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" icon={Sparkles} {...button} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <AiGenerateModal kind={kind} onClose={() => setOpen(false)} />}
    </>
  );
}

function AiGenerateModal({ kind, onClose }: { kind: Kind; onClose: () => void }) {
  const copy = COPY[kind];
  const toast = useToast();
  const navigate = useNavigate();
  const status = useLoad(() => aiApi.status(), []);
  const [offer, setOffer] = useState('');
  const [audience, setAudience] = useState('');
  const [tone, setTone] = useState<AiTone>('professionnel');
  const [language, setLanguage] = useState<AiLanguage>('fr');
  const [kit, setKit] = useState('');
  const [goal, setGoal] = useState<AiGoal>('capture');
  const [emails, setEmails] = useState(5);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const brief = { offer, audience, tone, language, ...(kit ? { kit } : {}) };
    const link_url = link.trim() || undefined;
    try {
      const started =
        kind === 'funnel' ? await aiApi.generateFunnel({ ...brief, goal }) : kind === 'campaign' ? await aiApi.generateCampaign({ ...brief, emails, link_url }) : await aiApi.generateNewsletter({ ...brief, link_url });
      abort.current = new AbortController();
      const g = await waitForGeneration(started.id, abort.current.signal);
      toast.success(kind === 'funnel' ? 'Tunnel généré' : kind === 'campaign' ? 'Campagne générée' : 'Newsletter générée');
      onClose();
      if (g.result?.funnel_id) navigate(`/funnels/${g.result.funnel_id}`);
      else if (g.result?.campaign_id) navigate(`/emails/campaigns/${g.result.campaign_id}`);
      else if (g.result?.broadcast_id) navigate(`/emails/broadcasts/${g.result.broadcast_id}`);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const configured = status.data?.configured;
  return (
    <Modal
      open
      onClose={onClose}
      title={copy.title}
      description={copy.description}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {busy ? 'Fermer' : 'Annuler'}
          </Button>
          <Button type="submit" form="ai-generate" icon={Sparkles} loading={busy} disabled={!configured || offer.trim().length < 10}>
            {copy.submit}
          </Button>
        </>
      }
    >
      {status.loading && !status.data ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : status.error ? (
        <p className="text-sm text-rose-600">{status.error}</p>
      ) : !configured ? (
        <AiNotConfigured />
      ) : busy ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Spinner size={28} />
          <p className="text-sm font-medium text-slate-800">{copy.progress}</p>
          <p className="max-w-sm text-xs text-slate-500">Cela prend généralement moins d’une minute. Vous pouvez fermer cette fenêtre : la génération continue et apparaîtra dans votre liste.</p>
        </div>
      ) : (
        <form id="ai-generate" onSubmit={submit} className="space-y-4">
          {kind === 'funnel' && (
            <Field label="Objectif du tunnel">
              <div className="grid gap-2 sm:grid-cols-3">
                {(Object.keys(AI_GOAL_LABELS) as AiGoal[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setGoal(g)}
                    aria-pressed={goal === g}
                    className={cx('rounded-xl border p-3 text-left transition-colors', goal === g ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-500' : 'border-slate-200 hover:bg-slate-50')}
                  >
                    <span className="block text-sm font-semibold text-slate-900">{AI_GOAL_LABELS[g].label}</span>
                    <span className="mt-0.5 block text-xs text-slate-500">{AI_GOAL_LABELS[g].description}</span>
                  </button>
                ))}
              </div>
            </Field>
          )}
          <Field label={copy.offerLabel} hint="Plus le brief est précis (produit, prix, bénéfices, preuves), meilleur est le résultat. L’IA n’invente ni prix ni témoignage : elle laisse des emplacements à compléter.">
            <Textarea data-autofocus required minLength={10} maxLength={2000} rows={4} value={offer} onChange={(e) => setOffer(e.target.value)} placeholder={copy.offerPlaceholder} />
          </Field>
          <Field label="Cible">
            <Input value={audience} maxLength={1000} onChange={(e) => setAudience(e.target.value)} placeholder="ex. Parents actifs qui manquent de temps pour cuisiner" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Ton">
              <Select value={tone} onChange={(e) => setTone(e.target.value as AiTone)}>
                {(Object.keys(AI_TONE_LABELS) as AiTone[]).map((t) => (
                  <option key={t} value={t}>
                    {AI_TONE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Langue">
              <Select value={language} onChange={(e) => setLanguage(e.target.value as AiLanguage)}>
                {(Object.keys(AI_LANGUAGE_LABELS) as AiLanguage[]).map((l) => (
                  <option key={l} value={l}>
                    {AI_LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Identité visuelle" hint="Un kit applique ses polices, ses couleurs et le style de ses boutons aux contenus générés.">
            <Select value={kit} onChange={(e) => setKit(e.target.value)}>
              <option value="">Standard (sans kit)</option>
              {KITS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name} — {k.universe}
                </option>
              ))}
            </Select>
          </Field>
          {kind !== 'funnel' && (
            <div className="grid gap-4 sm:grid-cols-2">
              {kind === 'campaign' && (
                <Field label="Nombre d’emails">
                  <Input type="number" min={1} max={10} value={emails} onChange={(e) => setEmails(Math.min(10, Math.max(1, Number(e.target.value) || 1)))} />
                </Field>
              )}
              <Field label="Lien du bouton (facultatif)" hint="Si vous l’indiquez, les emails se terminent par un bouton vers cette adresse." className={kind === 'newsletter' ? 'sm:col-span-2' : undefined}>
                <Input type="url" value={link} maxLength={500} onChange={(e) => setLink(e.target.value)} placeholder="https://…" />
              </Field>
            </div>
          )}
          {error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </form>
      )}
    </Modal>
  );
}

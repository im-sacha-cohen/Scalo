// « Migrer vers Scalo » : assistant d’import des contacts (systeme.io par clé API, ou fichier CSV exporté d’un autre
// outil), import d’une page par URL, historique des imports.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  ArrowLeft, ArrowRight, Ban, Check, CircleAlert, CircleCheck, Download, FileSpreadsheet, FileUp, Globe, History, KeyRound, LayoutTemplate, ShieldCheck, Tag as TagIcon, Upload, Users,
} from 'lucide-react';
import type { ImportAnalysis, ImportColumnMapping, ImportJob, ImportOptions, ImportPreview, PageImportResult } from '@scalo/shared';
import { MappingStep, mappingProblem } from './MappingStep';
import { api, downloadBlob } from '../../lib/api';
import { crmApi } from '../../lib/crm-api';
import { importApi, type ImportSourceInput } from '../../lib/import-api';
import { useLoad } from '../../lib/hooks';
import { fmtDateTime, fmtNumber } from '../../lib/format';
import { Badge, Button, Card, CardHeader, cx, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Spinner, Tabs, Textarea, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

type Source = 'systeme_io' | 'csv';
const STEPS = ['Source', 'Connexion', 'Correspondance', 'Options', 'Aperçu', 'Import', 'Rapport'] as const;
const STATUS: Record<ImportJob['status'], { label: string; tone: 'slate' | 'brand' | 'green' | 'red' | 'amber' }> = {
  pending: { label: 'En attente', tone: 'slate' },
  running: { label: 'En cours', tone: 'brand' },
  completed: { label: 'Terminé', tone: 'green' },
  failed: { label: 'Échec', tone: 'red' },
  cancelled: { label: 'Annulé', tone: 'amber' },
};
const isActive = (j: ImportJob) => j.status === 'pending' || j.status === 'running';

export function MigratePage() {
  const [params, setParams] = useSearchParams();
  const tab = (['contacts', 'page', 'history'] as const).find((t) => t === params.get('tab')) ?? 'contacts';
  return (
    <>
      <PageHeader
        title="Migrer vers Scalo"
        description="Reprenez vos contacts et vos pages depuis un autre outil, en quelques minutes et sans envoyer d’emails par surprise."
        back={
          <Link to="/contacts" className="inline-flex items-center gap-1 text-sm font-medium text-slate-500 hover:text-slate-800">
            <ArrowLeft size={15} /> Contacts
          </Link>
        }
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(t) => setParams(t === 'contacts' ? {} : { tab: t })}
        tabs={[
          { id: 'contacts', label: 'Contacts', icon: Users },
          { id: 'page', label: 'Pages', icon: LayoutTemplate },
          { id: 'history', label: 'Historique', icon: History },
        ]}
      />
      {tab === 'contacts' && <ContactsWizard initialSource={params.get('source') === 'csv' ? 'csv' : null} />}
      {tab === 'page' && <PageImport />}
      {tab === 'history' && <ImportHistory />}
    </>
  );
}

/* ---------------- contacts wizard ---------------- */

function Stepper({ step }: { step: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-xs font-medium">
      {STEPS.map((label, i) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={cx(
              'flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold',
              i < step ? 'bg-emerald-500 text-white' : i === step ? 'bg-brand-500 text-white' : 'bg-slate-100 text-slate-500',
            )}
          >
            {i < step ? <Check size={13} /> : i + 1}
          </span>
          <span className={cx(i === step ? 'text-ink' : 'text-slate-500')}>{label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-5 bg-slate-200" />}
        </li>
      ))}
    </ol>
  );
}

/** `initialSource`: « Importer » of the contact list opens the assistant directly on the CSV file step. */
function ContactsWizard({ initialSource }: { initialSource: Source | null }) {
  const toast = useToast();
  const [step, setStep] = useState(initialSource ? 1 : 0);
  const [source, setSource] = useState<Source>(initialSource ?? 'systeme_io');
  const [apiKey, setApiKey] = useState('');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<(ImportAnalysis & { tags?: string[] }) | null>(null);
  const [mapping, setMapping] = useState<ImportColumnMapping[]>([]);
  const [options, setOptions] = useState<ImportOptions>({ keep_existing: false, trigger: false, tag: '', consent: false });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [job, setJob] = useState<ImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const fields = useLoad(() => crmApi.customFields(), []);
  const tags = useLoad(() => api.tags(), []);

  const src: ImportSourceInput = source === 'csv' ? { source: 'csv', csv, file_name: fileName ?? undefined } : { source: 'systeme_io', api_key: apiKey.trim() };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const onFile = (f: File | undefined) => {
    if (!f) return;
    if (f.size > 5_000_000) {
      toast.error('Fichier trop volumineux (5 Mo maximum) : découpez-le en plusieurs fichiers.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ''));
      setFileName(f.name);
    };
    reader.readAsText(f);
  };

  const analyze = () =>
    run(async () => {
      const a = source === 'csv' ? await importApi.analyzeCsv(csv) : await importApi.connectSystemeIo(apiKey.trim());
      setAnalysis(a);
      setMapping(a.mapping);
      setStep(2);
    });

  const loadPreview = () =>
    run(async () => {
      setPreview(await importApi.preview(src, mapping));
      setStep(4);
    });

  const start = () =>
    run(async () => {
      const j = await importApi.start(src, mapping, { ...options, tag: options.tag?.trim() || null });
      setApiKey(''); // the key is no longer needed in the browser
      setJob(j);
      setStep(5);
    });

  // progress: poll while the job is pending / running
  const jobId = job?.id;
  const active = job ? isActive(job) : false;
  useEffect(() => {
    if (!jobId || !active) return;
    const t = setInterval(async () => {
      try {
        const j = await importApi.get(jobId);
        setJob(j);
        if (!isActive(j)) setStep(6);
      } catch {
        /* transient: keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [jobId, active]);

  const reset = () => {
    setStep(0);
    setCsv('');
    setFileName(null);
    setApiKey('');
    setAnalysis(null);
    setMapping([]);
    setPreview(null);
    setJob(null);
    setOptions({ keep_existing: false, trigger: false, tag: '', consent: false });
    fields.reload();
  };

  const problem = mappingProblem(mapping);
  const nav = (back: number | null, next?: { label: string; onClick: () => void; disabled?: boolean; icon?: typeof ArrowRight }) => (
    <div className="mt-6 flex items-center justify-between gap-3 border-t border-slate-100 pt-4">
      {back !== null ? (
        <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(back)} disabled={busy}>
          Retour
        </Button>
      ) : (
        <span />
      )}
      {next && (
        <Button iconRight={next.icon ?? ArrowRight} onClick={next.onClick} loading={busy} disabled={next.disabled}>
          {next.label}
        </Button>
      )}
    </div>
  );

  return (
    <Card>
      <Stepper step={step} />

      {step === 0 && (
        <>
          <CardHeader title="D’où viennent vos contacts ?" description="Rien n’est importé avant la dernière étape : vous pourrez vérifier la correspondance des champs et un aperçu." />
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                { id: 'systeme_io', icon: KeyRound, title: 'Importer depuis systeme.io', text: 'Avec une clé API de votre compte : contacts, champs personnalisés, tags et désinscriptions sont repris automatiquement.' },
                { id: 'csv', icon: FileSpreadsheet, title: 'Importer un fichier CSV', text: 'Export de systeme.io, Mailchimp, Brevo, ActiveCampaign, Kit (ConvertKit) ou tout autre fichier : les colonnes sont reconnues automatiquement.' },
              ] as const
            ).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setSource(s.id)}
                aria-pressed={source === s.id}
                className={cx(
                  'rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-4 focus-visible:ring-brand-500/20',
                  source === s.id ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300',
                )}
              >
                <s.icon size={20} className="mb-2 text-brand-600" />
                <p className="text-sm font-semibold text-ink">{s.title}</p>
                <p className="mt-1 text-sm text-slate-500">{s.text}</p>
              </button>
            ))}
          </div>
          {nav(null, { label: 'Continuer', onClick: () => setStep(1) })}
        </>
      )}

      {step === 1 && source === 'systeme_io' && (
        <>
          <CardHeader
            icon={KeyRound}
            title="Connexion à systeme.io"
            description="Créez une clé dans votre compte systeme.io (Paramètres → Clés API publiques), puis collez-la ici."
          />
          <Field label="Clé API systeme.io" hint="La clé sert uniquement à lire vos contacts. Elle est chiffrée pendant l’import, effacée dès qu’il se termine et n’apparaît dans aucun journal.">
            <Input icon={KeyRound} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Collez votre clé API" />
          </Field>
          {nav(0, { label: 'Tester la connexion', onClick: analyze, disabled: apiKey.trim().length < 8 })}
        </>
      )}

      {step === 1 && source === 'csv' && (
        <>
          <CardHeader icon={FileSpreadsheet} title="Votre fichier" description="Fichier CSV avec une ligne d’en-tête (séparateur virgule, point-virgule ou tabulation), 5 Mo maximum." />
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                onFile(e.dataTransfer.files[0]);
              }}
              className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
            >
              <FileUp size={28} className="mb-2 text-brand-500" />
              <span className="text-sm font-semibold text-slate-800">{fileName ?? 'Choisir un fichier CSV'}</span>
              <span className="mt-1 text-xs text-slate-500">ou glissez-le ici — vous pouvez aussi coller le contenu ci-dessous</span>
            </button>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <Field label="Contenu CSV">
              <Textarea
                rows={6}
                className="font-mono text-xs"
                value={csv.length > 20_000 ? `${csv.slice(0, 20_000)}\n…` : csv}
                readOnly={csv.length > 20_000}
                onChange={(e) => {
                  setCsv(e.target.value);
                  setFileName(null);
                }}
                placeholder={'email,prenom,nom,tags\nmarie@exemple.com,Marie,Dupont,"client, vip"'}
              />
            </Field>
          </div>
          {nav(0, { label: 'Analyser le fichier', onClick: analyze, disabled: !csv.trim() })}
        </>
      )}

      {step === 2 && analysis && (
        <>
          <CardHeader
            title="Correspondance des champs"
            description={
              <>
                Format reconnu : <Badge tone="brand">{analysis.preset_label}</Badge>
                {analysis.rows !== null && <> · {fmtNumber(analysis.rows)} ligne{analysis.rows > 1 ? 's' : ''}</>}. Vérifiez chaque colonne ; rien n’est créé sans votre accord.
              </>
            }
          />
          <MappingStep analysis={analysis} mapping={mapping} onChange={setMapping} fields={fields.data ?? []} />
          {problem && <p className="mt-3 flex items-center gap-1.5 text-sm text-rose-600"><CircleAlert size={15} /> {problem}</p>}
          {nav(1, { label: 'Continuer', onClick: () => setStep(3), disabled: !!problem })}
        </>
      )}

      {step === 3 && (
        <>
          <CardHeader title="Options de l’import" />
          <div className="space-y-5">
            <Toggle
              checked={!options.trigger}
              onChange={(v) => setOptions({ ...options, trigger: !v })}
              label="Ne rien déclencher pendant l’import (recommandé)"
              description="Les tags sont ajoutés sans démarrer vos campagnes ni vos automatisations : aucun email ne part. Désactivez pour que les contacts importés entrent dans vos séquences."
            />
            <Toggle
              checked={options.keep_existing}
              onChange={(v) => setOptions({ ...options, keep_existing: v })}
              label="Ne pas écraser les champs existants"
              description="Pour un contact déjà présent, seules les informations vides sont complétées."
            />
            <Field label="Ajouter un tag à tous les contacts importés (facultatif)">
              <Input list="migrate-tags" icon={TagIcon} value={options.tag ?? ''} maxLength={60} onChange={(e) => setOptions({ ...options, tag: e.target.value })} placeholder="ex. import-systeme-io" />
              <datalist id="migrate-tags">{(tags.data ?? []).map((t) => <option key={t.id} value={t.name} />)}</datalist>
            </Field>
            <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
              <p className="mb-2 flex items-center gap-2 font-semibold text-slate-800"><ShieldCheck size={16} className="text-emerald-600" /> Désinscriptions respectées</p>
              Les contacts désinscrits ou en erreur (bounce) dans votre ancien outil le restent dans Scalo, et un contact déjà désinscrit ici n’est jamais réinscrit. Les autres sont considérés comme confirmés ; ceux en attente de double opt-in restent en attente.
            </div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={options.consent} onChange={(e) => setOptions({ ...options, consent: e.target.checked })} />
              <span className="text-sm text-slate-700">
                <span className="font-semibold text-ink">J’atteste que ces contacts ont accepté de recevoir mes emails</span> et que je peux prouver leur consentement (RGPD). Je n’importe pas de liste achetée ou louée.
              </span>
            </label>
          </div>
          {nav(2, { label: 'Voir l’aperçu', onClick: loadPreview, disabled: !options.consent })}
        </>
      )}

      {step === 4 && preview && (
        <>
          <CardHeader
            title="Aperçu avant import"
            description={preview.partial ? 'Échantillon des 50 premiers contacts du compte : l’import traitera tous les contacts.' : 'Calculé sur tout le fichier. Rien n’est encore enregistré.'}
          />
          <PreviewPanel preview={preview} options={options} />
          {nav(3, { label: 'Lancer l’import', onClick: start, icon: Upload, disabled: preview.valid === 0 })}
        </>
      )}

      {step === 5 && job && (
        <>
          <CardHeader title="Import en cours" description="Vous pouvez quitter cette page : l’import continue en arrière-plan et reprend seul après une interruption." />
          <JobProgress job={job} />
          <div className="mt-6 flex justify-end border-t border-slate-100 pt-4">
            <Button
              variant="secondary"
              icon={Ban}
              loading={busy}
              onClick={() =>
                run(async () => {
                  setJob(await importApi.cancel(job.id));
                  setStep(6);
                })
              }
            >
              Annuler l’import
            </Button>
          </div>
        </>
      )}

      {step === 6 && job && (
        <>
          <CardHeader title="Rapport d’import" />
          <JobReport job={job} />
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <Button variant="ghost" onClick={reset}>Nouvel import</Button>
            <Link to="/contacts" className="inline-flex h-9 items-center gap-2 rounded-full bg-brand-500 px-4 text-sm font-semibold text-white hover:bg-brand-600">
              Voir mes contacts <ArrowRight size={16} />
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, tone = 'slate' }: { label: string; value: number | string; tone?: 'slate' | 'green' | 'brand' | 'amber' | 'red' }) {
  const tones = { slate: 'bg-slate-100 text-slate-700', green: 'bg-emerald-50 text-emerald-700', brand: 'bg-brand-50 text-brand-700', amber: 'bg-amber-50 text-amber-800', red: 'bg-rose-50 text-rose-700' };
  return (
    <div className={cx('rounded-xl p-4', tones[tone])}>
      <p className="text-2xl font-bold">{typeof value === 'number' ? fmtNumber(value) : value}</p>
      <p className="mt-0.5 text-sm font-medium">{label}</p>
    </div>
  );
}

const PREVIEW_STATUS: Record<ImportPreview['sample'][number]['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'slate' }> = {
  subscribed: { label: 'Abonné', tone: 'green' },
  unsubscribed: { label: 'Désinscrit', tone: 'slate' },
  bounced: { label: 'Bounce', tone: 'red' },
  pending: { label: 'En attente', tone: 'amber' },
};

function PreviewPanel({ preview, options }: { preview: ImportPreview; options: ImportOptions }) {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Nouveaux contacts" value={preview.valid - preview.existing} tone="green" />
        <Stat label="Déjà présents (mis à jour)" value={preview.existing} tone="brand" />
        <Stat label="Désinscrits / bounces" value={preview.unsubscribed + preview.bounced} />
        <Stat label="Lignes ignorées" value={preview.invalid + preview.empty + preview.duplicates} tone={preview.invalid ? 'amber' : 'slate'} />
      </div>
      <ul className="space-y-1 text-sm text-slate-600">
        {preview.invalid > 0 && <li>{fmtNumber(preview.invalid)} adresse{preview.invalid > 1 ? 's' : ''} email invalide{preview.invalid > 1 ? 's' : ''} (détail dans le journal d’erreurs après l’import).</li>}
        {preview.duplicates > 0 && <li>{fmtNumber(preview.duplicates)} doublon{preview.duplicates > 1 ? 's' : ''} dans la source.</li>}
        {preview.pending > 0 && <li>{fmtNumber(preview.pending)} contact{preview.pending > 1 ? 's' : ''} en attente de confirmation (double opt-in) : importé{preview.pending > 1 ? 's' : ''} non confirmé{preview.pending > 1 ? 's' : ''}.</li>}
        {preview.new_fields.length > 0 && <li>Champs créés : {preview.new_fields.map((f) => `« ${f} »`).join(', ')}.</li>}
        {(preview.invalid_values ?? []).map((iv) => (
          <li key={iv.column} className="text-amber-800">
            Colonne « {iv.column} » → {iv.field} : {fmtNumber(iv.count)} valeur{iv.count > 1 ? 's' : ''} invalide{iv.count > 1 ? 's' : ''} (ex. {iv.examples.map((x) => `« ${x} »`).join(', ')}), ignorée{iv.count > 1 ? 's' : ''} et listée{iv.count > 1 ? 's' : ''} dans le journal.
          </li>
        ))}
        {preview.tags.length > 0 && (
          <li className="flex flex-wrap items-center gap-1.5">
            Tags repris : {preview.tags.slice(0, 20).map((t) => <Badge key={t}>{t}</Badge>)}
            {preview.tags.length > 20 && <span className="text-slate-500">+ {preview.tags.length - 20}</span>}
          </li>
        )}
        <li>{options.trigger ? 'Les campagnes et automatisations liées aux tags seront déclenchées.' : 'Aucune campagne ni automatisation ne sera déclenchée : aucun email ne part.'}</li>
      </ul>
      {preview.sample.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold tracking-wide text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Nom</th>
                <th className="px-4 py-2.5">Tags</th>
                <th className="px-4 py-2.5">Inscription</th>
                <th className="px-4 py-2.5">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.sample.map((c) => (
                <tr key={c.email}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">
                    {c.email} {c.exists && <Badge tone="brand" className="ml-1">existe</Badge>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600">{[c.first_name, c.last_name].filter(Boolean).join(' ') || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600">{c.tags.join(', ') || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600">{c.created_at ? fmtDateTime(c.created_at) : 'Aujourd’hui'}</td>
                  <td className="px-4 py-2.5"><Badge tone={PREVIEW_STATUS[c.status].tone}>{PREVIEW_STATUS[c.status].label}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function JobProgress({ job }: { job: ImportJob }) {
  const pct = job.total ? Math.min(100, Math.round((job.processed / job.total) * 100)) : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 text-sm text-slate-600">
        <Spinner size={18} />
        <span aria-live="polite">
          {fmtNumber(job.processed)} {job.total !== null ? `sur ${fmtNumber(job.total)} lignes traitées` : 'contacts traités'}
          {pct !== null && ` (${pct} %)`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cx('h-full rounded-full bg-brand-500 transition-all', pct === null && 'w-1/3 animate-pulse')} style={pct !== null ? { width: `${pct}%` } : undefined} />
      </div>
      {job.note && <p className="flex items-center gap-1.5 text-sm text-amber-700"><CircleAlert size={15} /> {job.note}</p>}
      <JobCounters job={job} />
    </div>
  );
}

function JobCounters({ job }: { job: ImportJob }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <Stat label="Créés" value={job.created} tone="green" />
      <Stat label="Mis à jour" value={job.updated} tone="brand" />
      <Stat label="Ignorés" value={job.skipped} />
      <Stat label="Erreurs" value={job.errors} tone={job.errors ? 'red' : 'slate'} />
    </div>
  );
}

function ErrorsButton({ job }: { job: ImportJob }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  if (job.errors + job.warnings === 0) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={Download}
      loading={loading}
      onClick={async () => {
        setLoading(true);
        try {
          downloadBlob(await importApi.errorsCsv(job.id), `import-${job.id}-erreurs.csv`);
        } catch (e) {
          toast.error(e);
        } finally {
          setLoading(false);
        }
      }}
    >
      Télécharger le journal (CSV)
    </Button>
  );
}

function JobReport({ job }: { job: ImportJob }) {
  return (
    <div className="space-y-4">
      <p className={cx('flex items-center gap-2 text-sm font-semibold', job.status === 'completed' ? 'text-emerald-700' : job.status === 'failed' ? 'text-rose-700' : 'text-amber-700')}>
        {job.status === 'completed' ? <CircleCheck size={18} /> : <CircleAlert size={18} />}
        {job.status === 'completed' && 'Import terminé.'}
        {job.status === 'cancelled' && 'Import annulé : les contacts déjà importés sont conservés.'}
        {job.status === 'failed' && (job.error ?? 'L’import a échoué.')}
      </p>
      <JobCounters job={job} />
      {job.warnings > 0 && <p className="text-sm text-slate-600">{fmtNumber(job.warnings)} avertissement{job.warnings > 1 ? 's' : ''} (valeurs ignorées, doublons) : les contacts concernés ont tout de même été importés.</p>}
      {!job.options.trigger && job.status === 'completed' && <p className="text-sm text-slate-600">Aucune campagne ni automatisation n’a été déclenchée.</p>}
      <ErrorsButton job={job} />
    </div>
  );
}

/* ---------------- history ---------------- */

function ImportHistory() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => importApi.list(), []);
  const anyActive = data?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [anyActive, reload]);

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-40 w-full rounded-2xl" />;
  if (!data.length) return <EmptyState icon={History} title="Aucun import pour le moment" description="Vos imports de contacts apparaîtront ici, avec leur rapport et leur journal d’erreurs." />;
  return (
    <Card padded={false}>
      <ul className="divide-y divide-slate-100">
        {data.map((j) => (
          <li key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-sm font-semibold text-ink">
                {j.label || 'Import'} <Badge tone={STATUS[j.status].tone}>{STATUS[j.status].label}</Badge>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                {fmtDateTime(j.created_at)} · {fmtNumber(j.created)} créés · {fmtNumber(j.updated)} mis à jour · {fmtNumber(j.skipped)} ignorés · {fmtNumber(j.errors)} erreur{j.errors > 1 ? 's' : ''}
                {isActive(j) && j.total !== null && ` · ${fmtNumber(j.processed)} / ${fmtNumber(j.total)}`}
              </p>
              {(j.error || j.note) && <p className="mt-1 text-xs text-amber-700">{j.error ?? j.note}</p>}
            </div>
            <ErrorsButton job={j} />
            {isActive(j) && (
              <Button
                variant="secondary"
                size="sm"
                icon={Ban}
                onClick={async () => {
                  try {
                    await importApi.cancel(j.id);
                    reload();
                  } catch (e) {
                    toast.error(e);
                  }
                }}
              >
                Annuler
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/* ---------------- page import by URL ---------------- */

function PageImport() {
  const toast = useToast();
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PageImportResult | null>(null);
  const [target, setTarget] = useState<'new' | number>('new');
  const funnels = useLoad(() => api.funnels(), []);

  const fetchPage = async () => {
    setBusy(true);
    try {
      setResult(await importApi.importPage(url.trim(), consent));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!result) return;
    setBusy(true);
    try {
      const name = result.title.slice(0, 80) || 'Page importée';
      const type = result.stats.forms > 0 ? 'optin' : 'sales';
      let funnelId: number;
      let stepId: number;
      if (target === 'new') {
        const funnel = await api.createFunnel({ name, template: 'blank' });
        funnelId = funnel.id;
        const first = funnel.steps?.[0];
        if (first) stepId = (await api.updateStep(first.id, { name, type, content: result.content })).id;
        else stepId = (await api.createStep(funnelId, { name, type, content: result.content })).id;
      } else {
        funnelId = target;
        stepId = (await api.createStep(funnelId, { name, type, content: result.content })).id;
      }
      toast.success('Page importée : vous pouvez la modifier.');
      navigate(`/funnels/${funnelId}/steps/${stepId}/edit`);
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };

  const s = result?.stats;
  return (
    <Card>
      <CardHeader
        icon={Globe}
        title="Importer une page par URL"
        description="systeme.io ne propose pas d’export de pages. Scalo lit votre page publique et en reprend la structure et les textes (titres, paragraphes, listes, boutons, images, formulaire) sous forme de blocs modifiables."
      />
      <div className="space-y-4">
        <Field label="Adresse de la page" hint="Page publique en https:// (pas de page protégée par mot de passe).">
          <Input icon={Globe} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://votre-site.systeme.io/ma-page" />
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-4">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="text-sm text-slate-700">
            <span className="font-semibold text-ink">J’atteste que cette page m’appartient</span> et que je détiens les droits sur ses textes et ses images.
          </span>
        </label>
        <div className="rounded-xl bg-slate-50 p-4 text-sm text-slate-600">
          Version volontairement simple : la mise en page, les couleurs, les polices, les vidéos et les scripts ne sont pas repris, et une page affichée uniquement par JavaScript ne peut pas être lue. Comptez quelques minutes de retouches dans l’éditeur.
        </div>
        <div className="flex justify-end">
          <Button icon={Download} onClick={fetchPage} loading={busy && !result} disabled={!url.trim() || !consent}>
            Analyser la page
          </Button>
        </div>
      </div>

      {result && s && (
        <div className="mt-6 space-y-4 border-t border-slate-100 pt-5">
          <p className="text-sm font-semibold text-ink">« {result.title} »</p>
          <div className="flex flex-wrap gap-2 text-sm">
            {(
              [
                [s.headings, 'titre'], [s.texts, 'texte'], [s.lists, 'liste'], [s.images, 'image'], [s.buttons, 'bouton'], [s.forms, 'formulaire'],
              ] as const
            )
              .filter(([n]) => n > 0)
              .map(([n, l]) => <Badge key={l} tone="brand">{n} {l}{n > 1 ? 's' : ''}</Badge>)}
          </div>
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          <Field label="Enregistrer dans">
            <Select value={String(target)} onChange={(e) => setTarget(e.target.value === 'new' ? 'new' : Number(e.target.value))}>
              <option value="new">Un nouveau tunnel</option>
              {(funnels.data ?? []).map((f) => <option key={f.id} value={f.id}>Tunnel « {f.name} » (nouvelle étape)</option>)}
            </Select>
          </Field>
          <div className="flex justify-end">
            <Button iconRight={ArrowRight} onClick={save} loading={busy}>
              Créer la page et l’ouvrir dans l’éditeur
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

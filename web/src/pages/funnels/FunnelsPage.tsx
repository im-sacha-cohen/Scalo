import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Eye, Funnel as FunnelIcon, Layers, MousePointerClick, Plus, CircleCheck, FileText, Percent, Upload } from 'lucide-react';
import { FUNNEL_TEMPLATES, type Funnel } from '@scalo/shared';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate, fmtNumber, fmtPercent, ratio, STEP_TYPE_LABELS } from '../../lib/format';
import { Button, Card, cx, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { ImportFunnelModal } from './growth/ImportFunnelModal';
import { useToast } from '../../components/Toast';
import { AiGenerateButton } from '../ai/AiGenerate';

const TEMPLATE_ACCENTS: Record<string, string> = {
  optin: 'from-brand-500 to-violet-500',
  sales: 'from-emerald-500 to-teal-500',
  blank: 'from-slate-400 to-slate-500',
};

export function FunnelsPage() {
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useLoad(() => api.funnels(), []);
  const [createOpen, setCreateOpen] = useState(params.get('new') === '1');
  const [importOpen, setImportOpen] = useState(false);

  const closeCreate = () => {
    setCreateOpen(false);
    if (params.get('new')) {
      params.delete('new');
      setParams(params, { replace: true });
    }
  };

  return (
    <>
      <PageHeader
        title="Tunnels de vente"
        description="Créez des pages de capture, de vente et de remerciement enchaînées."
        actions={
          <>
            <Button variant="secondary" icon={Upload} onClick={() => setImportOpen(true)}>
              Importer
            </Button>
            <AiGenerateButton kind="funnel" />
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>
              Nouveau tunnel
            </Button>
          </>
        }
      />

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-2 h-3.5 w-28" />
              <Skeleton className="mt-6 h-14 w-full" />
            </Card>
          ))}
        </div>
      ) : data && data.length === 0 ? (
        <EmptyState
          icon={FunnelIcon}
          title="Créez votre premier tunnel"
          description="Choisissez un modèle (capture d’emails, tunnel de vente…) et personnalisez chaque page dans l’éditeur."
          action={
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>
              Nouveau tunnel
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {data?.map((f) => <FunnelCard key={f.id} f={f} />)}
          <button
            onClick={() => setCreateOpen(true)}
            className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 text-sm font-medium text-slate-500 transition-colors hover:border-brand-400 hover:bg-brand-50/40 hover:text-brand-700"
          >
            <Plus size={22} />
            Nouveau tunnel
          </button>
        </div>
      )}

      <CreateFunnelModal open={createOpen} onClose={closeCreate} />
      <ImportFunnelModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

function FunnelCard({ f }: { f: Funnel }) {
  const views = f.views ?? 0;
  const optins = f.optins ?? 0;
  return (
    <Link to={`/funnels/${f.id}`} className="group block">
      <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:border-brand-200 group-hover:shadow-pop">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white shadow-md shadow-brand-600/20">
            <FunnelIcon size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-semibold text-slate-900 group-hover:text-brand-700">{f.name}</h3>
            <p className="truncate text-xs text-slate-500">/p/{f.slug}</p>
          </div>
        </div>
        <div className="mt-5 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
          <Metric icon={Eye} label="Vues" value={fmtNumber(views)} />
          <Metric icon={MousePointerClick} label="Optins" value={fmtNumber(optins)} />
          <Metric icon={Percent} label="Conversion" value={fmtPercent(ratio(optins, views))} />
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Layers size={14} /> {f.steps_count ?? 0} étape{(f.steps_count ?? 0) > 1 ? 's' : ''}
          </span>
          <span>Créé le {fmtDate(f.created_at)}</span>
        </div>
      </Card>
    </Link>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof Eye; label: string; value: string }) {
  return (
    <div>
      <p className="flex items-center justify-center gap-1 text-[11px] font-medium text-slate-500">
        <Icon size={12} /> {label}
      </p>
      <p className="mt-0.5 text-sm font-bold text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}

function CreateFunnelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<string>('optin');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setTemplate('optin');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const f = await api.createFunnel({ name: name.trim(), template });
      toast.success('Tunnel créé');
      onClose();
      navigate(`/funnels/${f.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Nouveau tunnel"
      description="Donnez-lui un nom et choisissez un modèle de départ."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="create-funnel" loading={saving} disabled={!name.trim()}>
            Créer le tunnel
          </Button>
        </>
      }
    >
      <form id="create-funnel" onSubmit={submit} className="space-y-5">
        <Field label="Nom du tunnel">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Guide gratuit marketing" />
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Modèle</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {Object.entries(FUNNEL_TEMPLATES).map(([key, t]) => {
              const active = template === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTemplate(key)}
                  className={cx(
                    'relative flex flex-col rounded-xl border-2 p-3 text-left transition-all',
                    active ? 'border-brand-500 bg-brand-50/50 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  {active && <CircleCheck size={18} className="absolute top-2.5 right-2.5 text-brand-600" />}
                  <div className={cx('mb-3 flex h-16 items-end gap-1 rounded-lg bg-gradient-to-br p-2', TEMPLATE_ACCENTS[key] ?? TEMPLATE_ACCENTS.blank)}>
                    {t.steps.map((_, i) => (
                      <span key={i} className="flex h-full flex-1 flex-col gap-1 rounded bg-white/90 p-1">
                        <span className="h-1 w-3/4 rounded bg-slate-300" />
                        <span className="h-1 w-1/2 rounded bg-slate-200" />
                        <span className="mt-auto h-1.5 w-full rounded bg-slate-400/60" />
                      </span>
                    ))}
                  </div>
                  <span className="text-sm font-semibold text-slate-900">{t.label}</span>
                  <span className="mt-0.5 text-xs text-slate-500">{t.description}</span>
                  <span className="mt-2 flex flex-wrap gap-1">
                    {t.steps.map((s, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded bg-white px-1.5 py-0.5 text-[10px] font-medium text-slate-600 ring-1 ring-slate-200">
                        <FileText size={10} /> {s.name}
                        <span className="text-slate-400">· {STEP_TYPE_LABELS[s.type]}</span>
                      </span>
                    ))}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </form>
    </Modal>
  );
}

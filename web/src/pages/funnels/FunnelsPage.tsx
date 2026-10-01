import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Eye, Funnel as FunnelIcon, Layers, MousePointerClick, Plus, Percent, Upload } from 'lucide-react';
import { KITS, KIT_FLOWS, type Funnel, type KitGoal } from '@scalo/shared';
import { Chips, KIT_GOAL_LABELS, KitCards, KitFlowStrip, KitSwatch, SearchBox, kitMatches } from '../../builder/kits';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate, fmtNumber, fmtPercent, ratio } from '../../lib/format';
import { Button, Card, cx, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { ImportFunnelModal } from './growth/ImportFunnelModal';
import { useToast } from '../../components/Toast';
import { AiGenerateButton } from '../ai/AiGenerate';

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
  const [kitId, setKitId] = useState<string>(KITS[0]!.id);
  const [flow, setFlow] = useState<KitGoal>('capture');
  const [goal, setGoal] = useState<KitGoal | 'all'>('all');
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setKitId(KITS[0]!.id);
      setFlow('capture');
      setGoal('all');
      setQuery('');
    }
  }, [open]);

  const kits = useMemo(() => KITS.filter((k) => (goal === 'all' || k.goals.includes(goal)) && kitMatches(k, query)), [goal, query]);
  const kit = KITS.find((k) => k.id === kitId) ?? KITS[0]!;

  const pickGoal = (g: KitGoal | 'all') => {
    setGoal(g);
    if (g !== 'all') setFlow(g);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const f = await api.createFunnel({ name: name.trim(), template: 'blank', kit: kit.id, flow });
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
      size="full"
      title="Nouveau tunnel"
      description="Choisissez un kit : toutes les pages du tunnel partagent la même identité visuelle, et vos emails pourront la reprendre."
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
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[260px] flex-1">
            <Field label="Nom du tunnel">
              <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Guide gratuit marketing" />
            </Field>
          </div>
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-3">
                <Chips
                  label="Objectif"
                  value={goal}
                  onChange={pickGoal}
                  options={[['all', 'Tous'], ...(Object.keys(KIT_FLOWS) as KitGoal[]).map((g): [KitGoal, string] => [g, KIT_GOAL_LABELS[g]])]}
                />
                <div className="min-w-[180px] flex-1">
                  <SearchBox value={query} onChange={setQuery} placeholder="Rechercher un kit (univers, style…)" />
                </div>
              </div>
              <KitCards value={kit.id} onChange={setKitId} kits={kits} thumb={KIT_FLOWS[flow].steps[0]} width={178} />
            </div>

            <aside className="rounded-xl border border-slate-200 bg-slate-50/60 p-4 lg:sticky lg:top-0">
              <p className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">Kit {kit.name}</span>
                <KitSwatch kit={kit} />
              </p>
              <p className="mt-1 text-xs leading-snug text-slate-500">{kit.pitch}</p>
              <p className="mt-4 mb-2 text-sm font-medium text-slate-700">Type de tunnel</p>
              <div role="radiogroup" aria-label="Type de tunnel" className="space-y-1.5">
                {(Object.keys(KIT_FLOWS) as KitGoal[]).map((g) => (
                  <button
                    key={g}
                    type="button"
                    role="radio"
                    aria-checked={flow === g}
                    data-flow={g}
                    onClick={() => setFlow(g)}
                    className={cx(
                      'flex w-full items-start gap-2 rounded-lg border bg-white px-3 py-2 text-left transition-colors',
                      flow === g ? 'border-brand-500 ring-2 ring-brand-500/15' : 'border-slate-200 hover:border-slate-300',
                    )}
                  >
                    <span className={cx('mt-1 h-3 w-3 shrink-0 rounded-full border-2', flow === g ? 'border-brand-500 bg-brand-500' : 'border-slate-300')} />
                    <span>
                      <span className="block text-sm font-semibold text-slate-900">{KIT_FLOWS[g].label}</span>
                      <span className="block text-xs text-slate-500">{KIT_FLOWS[g].description}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-4 mb-2 text-sm font-medium text-slate-700">
                {KIT_FLOWS[flow].steps.length} étapes, toutes dans le kit {kit.name}
              </p>
              <KitFlowStrip kitId={kit.id} goal={flow} width={148} />
            </aside>
          </div>
      </form>
    </Modal>
  );
}

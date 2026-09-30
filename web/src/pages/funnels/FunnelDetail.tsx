import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  Eye,
  GripVertical,
  Layers,
  MousePointerClick,
  Pencil,
  Percent,
  Plus,
  Settings2,
  Trash,
  Link2,
  Files,
  PanelsTopLeft,
  ShoppingCart,
  PartyPopper,
  FileText,
  Check,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import { DEFAULT_SETTINGS, KITS, KIT_PAGES, KIT_PAGE_KINDS, getKit, isKitPageKind, kitPage, kitPageForStep, renderPageDocument, type Funnel, type PageContent, type Step, type StepType } from '@scalo/shared';
import { DocThumb, stripScripts, usePageTemplatePreviews } from '../../builder/TemplateGallery';
import { kitPagePreview } from '../../builder/kits';
import { api } from '../../lib/api';
import { copyText, useLoad } from '../../lib/hooks';
import { fmtNumber, fmtPercent, ratio, slugify, STEP_TYPE_LABELS } from '../../lib/format';
import { Badge, Button, Card, cx, ErrorState, Field, IconButton, Input, PageLoader, StatCard, Tabs } from '../../components/ui';
import { FunnelStatsTab } from './growth/FunnelStatsTab';
import { FunnelDomainsTab } from './growth/FunnelDomainsTab';
import { FunnelTrackingTab } from './growth/FunnelTrackingTab';
import { FunnelShareTab } from './growth/FunnelShareTab';
import { StepAbCard } from './growth/StepAbCard';

type FunnelTab = 'steps' | 'stats' | 'domains' | 'tracking' | 'share';
const FUNNEL_TABS: FunnelTab[] = ['steps', 'stats', 'domains', 'tracking', 'share'];
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { accessLabel, isProtected, StepAccessModal } from './StepAccessModal';

const restrictToVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

export const STEP_TYPE_META: Record<StepType, { icon: LucideIcon; tone: 'brand' | 'green' | 'amber' | 'slate'; desc: string }> = {
  optin: { icon: PanelsTopLeft, tone: 'brand', desc: 'Capturez des emails avec un formulaire' },
  sales: { icon: ShoppingCart, tone: 'green', desc: 'Présentez votre offre' },
  thankyou: { icon: PartyPopper, tone: 'amber', desc: 'Remerciez après l’inscription' },
  custom: { icon: FileText, tone: 'slate', desc: 'Page libre' },
};

export const publicUrl = (funnelSlug: string, stepSlug?: string) => `${window.location.origin}/p/${funnelSlug}${stepSlug ? `/${stepSlug}` : ''}`;

export function FunnelDetailPage() {
  const { id } = useParams();
  const funnelId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const { data: funnel, setData, error, loading, reload } = useLoad(() => api.funnel(funnelId), [funnelId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [stepEdit, setStepEdit] = useState<Step | null>(null);
  const [accessEdit, setAccessEdit] = useState<Step | null>(null);
  const [duplicating, setDuplicating] = useState(false);

  const steps = useMemo(() => funnel?.steps ?? [], [funnel]);
  const selectedId = Number(params.get('step')) || steps[0]?.id;
  const selected = steps.find((s) => s.id === selectedId) ?? steps[0];
  const select = (sid: number) => {
    const p = new URLSearchParams(params);
    p.set('step', String(sid));
    setParams(p, { replace: true });
  };
  const tab: FunnelTab = FUNNEL_TABS.find((t) => t === params.get('tab')) ?? 'steps';
  const setTab = (t: FunnelTab) => {
    const p = new URLSearchParams(params);
    if (t === 'steps') p.delete('tab');
    else p.set('tab', t);
    setParams(p, { replace: true });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  if (loading && !funnel) return <PageLoader />;
  if (error && !funnel) return <ErrorState message={error} onRetry={reload} />;
  if (!funnel) return null;

  const setSteps = (next: Step[]) => setData({ ...funnel, steps: next });

  const onDragEnd = async (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = steps.findIndex((s) => s.id === e.active.id);
    const to = steps.findIndex((s) => s.id === e.over!.id);
    const prev = steps;
    const next = arrayMove(steps, from, to).map((s, i) => ({ ...s, position: i }));
    setSteps(next);
    try {
      await api.reorderSteps(funnel.id, next.map((s) => s.id));
    } catch (err) {
      setSteps(prev);
      toast.error(err);
    }
  };

  const duplicate = async () => {
    setDuplicating(true);
    try {
      const f = await api.duplicateFunnel(funnel.id);
      toast.success('Tunnel dupliqué');
      navigate(`/funnels/${f.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setDuplicating(false);
    }
  };

  const removeFunnel = async () => {
    const ok = await confirm({
      title: `Supprimer « ${funnel.name} » ?`,
      message: 'Toutes les étapes et leurs statistiques seront supprimées. Les contacts capturés sont conservés.',
      confirmLabel: 'Supprimer le tunnel',
    });
    if (!ok) return;
    try {
      await api.deleteFunnel(funnel.id);
      toast.success('Tunnel supprimé');
      navigate('/funnels');
    } catch (err) {
      toast.error(err);
    }
  };

  const removeStep = async (s: Step) => {
    const ok = await confirm({ title: `Supprimer l’étape « ${s.name} » ?`, message: 'La page et ses statistiques seront supprimées.', confirmLabel: 'Supprimer' });
    if (!ok) return;
    try {
      await api.deleteStep(s.id);
      setSteps(steps.filter((x) => x.id !== s.id));
      toast.success('Étape supprimée');
    } catch (err) {
      toast.error(err);
    }
  };

  const totalViews = steps[0]?.views ?? funnel.views ?? 0;
  const totalOptins = steps.reduce((a, s) => a + (s.optins ?? 0), 0) || funnel.optins || 0;

  return (
    <>
      <Link to="/funnels" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft size={16} /> Tunnels
      </Link>
      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{funnel.name}</h1>
          <UrlChip url={publicUrl(funnel.slug)} className="mt-2" />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={Settings2} onClick={() => setSettingsOpen(true)}>
            Paramètres
          </Button>
          <Button variant="secondary" icon={Files} onClick={duplicate} loading={duplicating}>
            Dupliquer
          </Button>
          <Button variant="secondary" icon={Trash} className="text-rose-600 hover:text-rose-700" onClick={removeFunnel}>
            Supprimer
          </Button>
        </div>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Étapes" value={steps.length} icon={Layers} tone="violet" />
        <StatCard label="Visiteurs (1re étape)" value={fmtNumber(totalViews)} icon={Eye} tone="sky" />
        <StatCard label="Optins" value={fmtNumber(totalOptins)} icon={MousePointerClick} tone="green" />
        <StatCard label="Conversion" value={fmtPercent(ratio(totalOptins, totalViews))} icon={Percent} tone="amber" />
      </div>

      <Tabs
        className="mb-6"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'steps', label: 'Étapes', count: steps.length },
          { id: 'stats', label: 'Statistiques' },
          { id: 'domains', label: 'Domaines' },
          { id: 'tracking', label: 'Suivi et RGPD' },
          { id: 'share', label: 'Partage' },
        ]}
      />
      {tab === 'stats' && <FunnelStatsTab funnel={funnel} />}
      {tab === 'domains' && <FunnelDomainsTab funnel={funnel} />}
      {tab === 'tracking' && <FunnelTrackingTab funnel={funnel} onFunnel={(f) => setData({ ...funnel, ...f })} />}
      {tab === 'share' && <FunnelShareTab funnel={funnel} />}

      {tab === 'steps' && (
      <div className="grid gap-6 lg:grid-cols-[340px_1fr]">
        <Card padded={false} className="h-fit overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Étapes du tunnel</h2>
            <Button size="xs" variant="secondary" icon={Plus} onClick={() => setAddOpen(true)}>
              Ajouter
            </Button>
          </div>
          {steps.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">Aucune étape. Ajoutez votre première page.</p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVertical]}>
              <SortableContext items={steps.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                <ol className="relative space-y-1 p-2">
                  {steps.map((s, i) => (
                    <StepRow key={s.id} step={s} index={i} active={s.id === selected?.id} onSelect={() => select(s.id)} />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          )}
          <p className="border-t border-slate-100 px-4 py-2.5 text-[11px] text-slate-400">Glissez les étapes pour changer leur ordre.</p>
        </Card>

        {selected ? (
          <StepPanel
            key={selected.id}
            funnel={funnel}
            step={selected}
            index={steps.findIndex((s) => s.id === selected.id)}
            onEdit={() => setStepEdit(selected)}
            onAccess={() => setAccessEdit(selected)}
            onDelete={() => removeStep(selected)}
          />
        ) : (
          <Card className="flex items-center justify-center py-20 text-sm text-slate-500">Ajoutez une étape pour commencer.</Card>
        )}
      </div>
      )}

      <FunnelSettingsModal
        open={settingsOpen}
        funnel={funnel}
        onClose={() => setSettingsOpen(false)}
        onSaved={(f) => {
          setData({ ...funnel, ...f, steps: funnel.steps });
          setSettingsOpen(false);
        }}
      />
      <AddStepModal
        open={addOpen}
        funnelId={funnel.id}
        funnelKit={funnel.settings?.kit ?? null}
        onClose={() => setAddOpen(false)}
        onCreated={(s) => {
          setSteps([...steps, { views: 0, optins: 0, ...s }]);
          setAddOpen(false);
          select(s.id);
        }}
      />
      <StepAccessModal
        step={accessEdit}
        onClose={() => setAccessEdit(null)}
        onSaved={(s) => setSteps(steps.map((x) => (x.id === s.id ? { ...x, ...s, views: x.views, optins: x.optins } : x)))}
      />
      <StepSettingsModal
        step={stepEdit}
        funnelSlug={funnel.slug}
        onClose={() => setStepEdit(null)}
        onSaved={(s) => {
          setSteps(steps.map((x) => (x.id === s.id ? { ...x, ...s, views: x.views, optins: x.optins } : x)));
          setStepEdit(null);
        }}
      />
    </>
  );
}

function StepRow({ step, index, active, onSelect }: { step: Step; index: number; active: boolean; onSelect: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: step.id });
  const meta = STEP_TYPE_META[step.type] ?? STEP_TYPE_META.custom;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition, zIndex: isDragging ? 10 : undefined }}
      className={cx(
        'group relative flex items-center gap-2 rounded-lg border px-2 py-2.5 transition-colors',
        active ? 'border-brand-200 bg-brand-50' : 'border-transparent hover:bg-slate-50',
        isDragging && 'bg-white shadow-pop',
      )}
    >
      <button {...attributes} {...listeners} className="cursor-grab rounded p-0.5 text-slate-300 hover:text-slate-600 active:cursor-grabbing" aria-label="Déplacer l’étape">
        <GripVertical size={16} />
      </button>
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs font-bold', active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600')}>
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate text-sm font-semibold', active ? 'text-brand-800' : 'text-slate-800')}>{step.name}</span>
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <meta.icon size={12} /> {STEP_TYPE_LABELS[step.type]} · {fmtNumber(step.views ?? 0)} vues
            {step.ab_status === 'running' && (
              <span title="Test A/B en cours" className="rounded bg-violet-100 px-1 text-[10px] font-bold text-violet-700">
                A/B
              </span>
            )}
            {isProtected(step.access) && (
              <span title={`Accès : ${accessLabel(step.access)}`} className="text-amber-600">
                <Lock size={12} />
              </span>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function UrlChip({ url, className }: { url: string; className?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx('inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-white py-1 pr-1 pl-2.5 shadow-card', className)}>
      <Link2 size={14} className="shrink-0 text-slate-400" />
      <a href={url} target="_blank" rel="noreferrer" className="truncate text-sm text-slate-600 hover:text-brand-700 hover:underline">
        {url.replace(/^https?:\/\//, '')}
      </a>
      <IconButton
        icon={copied ? Check : Copy}
        label="Copier le lien"
        size={14}
        className="h-7 w-7"
        onClick={async () => {
          if (await copyText(url)) {
            setCopied(true);
            toast.success('Lien copié');
            setTimeout(() => setCopied(false), 1500);
          }
        }}
      />
      <a href={url} target="_blank" rel="noreferrer" title="Ouvrir" className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900">
        <ExternalLink size={14} />
      </a>
    </div>
  );
}

function PagePreview({ step }: { step: Step }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.4);
  const html = useMemo(() => stripScripts(renderPageDocument(step.content, { title: step.name, nextUrl: '#', formAction: '#', baseUrl: window.location.origin })), [step.content, step.name]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / 1280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative h-[340px] overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      <iframe
        title="Aperçu"
        srcDoc={html}
        sandbox=""
        scrolling="no"
        tabIndex={-1}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        style={{ width: 1280, height: 340 / scale, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function StepPanel({ funnel, step, index, onEdit, onAccess, onDelete }: { funnel: Funnel; step: Step; index: number; onEdit: () => void; onAccess: () => void; onDelete: () => void }) {
  const meta = STEP_TYPE_META[step.type] ?? STEP_TYPE_META.custom;
  const views = step.views ?? 0;
  const optins = step.optins ?? 0;
  const navigate = useNavigate();
  const editUrl = `/funnels/${funnel.id}/steps/${step.id}/edit`;
  const previewUrl = step.preview_url || `/p/${funnel.slug}/${step.slug}?preview=1`;
  return (
    <Card className="animate-fade-in">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Badge tone={meta.tone}>
              <meta.icon size={12} /> {STEP_TYPE_LABELS[step.type]}
            </Badge>
            <span className="text-xs text-slate-400">Étape {index + 1}</span>
          </div>
          <h2 className="mt-2 truncate text-xl font-bold text-slate-900">{step.name}</h2>
          <UrlChip url={publicUrl(funnel.slug, step.slug)} className="mt-2" />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="secondary"
            size="sm"
            icon={Lock}
            onClick={onAccess}
            className={cx(isProtected(step.access) && 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100')}
            title="Qui peut ouvrir cette page"
          >
            {isProtected(step.access) ? accessLabel(step.access) : 'Accès'}
          </Button>
          <Button variant="secondary" size="sm" icon={Settings2} onClick={onEdit}>
            Paramètres
          </Button>
          <Button variant="ghost" size="sm" icon={Trash} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={onDelete}>
            Supprimer
          </Button>
        </div>
      </div>

      <div className="my-5 grid grid-cols-3 divide-x divide-slate-100 rounded-xl border border-slate-100 bg-slate-50/60 py-3 text-center">
        {[
          ['Vues uniques', fmtNumber(views)],
          ['Optins', fmtNumber(optins)],
          ['Taux de conversion', fmtPercent(ratio(optins, views))],
        ].map(([l, v]) => (
          <div key={l}>
            <p className="text-xs font-medium text-slate-500">{l}</p>
            <p className="mt-1 text-lg font-bold text-slate-900 tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      <div className="group relative">
        <PagePreview step={step} />
        <div className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg bg-slate-900/0 opacity-0 transition-all group-hover:bg-slate-900/40 group-hover:opacity-100">
          <Button icon={Pencil} onClick={() => navigate(editUrl)}>
            Modifier la page
          </Button>
          <Button variant="secondary" icon={Eye} onClick={() => window.open(previewUrl, '_blank')}>
            Aperçu
          </Button>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button icon={Pencil} onClick={() => navigate(editUrl)}>
          Modifier dans l’éditeur
        </Button>
        <Button variant="secondary" icon={ExternalLink} onClick={() => window.open(previewUrl, '_blank')}>
          Voir la page
        </Button>
      </div>
      <StepAbCard funnel={funnel} step={step} />
    </Card>
  );
}

function FunnelSettingsModal({ open, funnel, onClose, onSaved }: { open: boolean; funnel: Funnel; onClose: () => void; onSaved: (f: Funnel) => void }) {
  const toast = useToast();
  const [name, setName] = useState(funnel.name);
  const [slug, setSlug] = useState(funnel.slug);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setName(funnel.name);
      setSlug(funnel.slug);
    }
  }, [open, funnel.name, funnel.slug]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const f = await api.updateFunnel(funnel.id, { name: name.trim(), slug: slugify(slug) });
      toast.success('Tunnel mis à jour');
      onSaved(f);
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
      title="Paramètres du tunnel"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="funnel-settings" loading={saving}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="funnel-settings" onSubmit={submit} className="space-y-4">
        <Field label="Nom">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Adresse (slug)" hint={`${window.location.origin}/p/${slugify(slug) || '…'}`}>
          <Input required value={slug} onChange={(e) => setSlug(e.target.value)} onBlur={() => setSlug(slugify(slug))} />
        </Field>
      </form>
    </Modal>
  );
}

function TypePicker({ value, onChange }: { value: StepType; onChange: (t: StepType) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {(Object.keys(STEP_TYPE_META) as StepType[]).map((t) => {
        const m = STEP_TYPE_META[t];
        const active = value === t;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={cx(
              'flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition-colors',
              active ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200 hover:border-slate-300',
            )}
          >
            <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
              <m.icon size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-slate-900">{STEP_TYPE_LABELS[t]}</span>
              <span className="block text-xs text-slate-500">{m.desc}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AddStepModal({ open, funnelId, funnelKit, onClose, onCreated }: { open: boolean; funnelId: number; funnelKit: string | null; onClose: () => void; onCreated: (s: Step) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<StepType>('optin');
  const [saving, setSaving] = useState(false);
  const [tpl, setTpl] = useState<string>('default');
  useEffect(() => {
    if (open) {
      setName('');
      setType('optin');
      setTpl('default');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // 'default' sends no content: the server uses the funnel's kit page for the type (or the classic template)
      const kitChoice = /^kit:([a-z0-9-]+):(\w+)$/.exec(tpl);
      const chosen =
        tpl === 'blank'
          ? (funnelKit && kitPageForStep(funnelKit, 'custom')) || ({ settings: { ...DEFAULT_SETTINGS }, blocks: [] } as PageContent)
          : kitChoice && isKitPageKind(kitChoice[2])
            ? (kitPage(kitChoice[1]!, kitChoice[2]) ?? undefined)
            : TEMPLATE_BUILDERS[tpl]?.();
      const s = await api.createStep(funnelId, { name: name.trim(), type, content: chosen });
      toast.success('Étape ajoutée');
      onCreated(s);
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
      title="Ajouter une étape"
      description="Choisissez un modèle de départ : tout reste modifiable dans l’éditeur."
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="add-step" loading={saving} disabled={!name.trim()}>
            Ajouter l’étape
          </Button>
        </>
      }
    >
      <form id="add-step" onSubmit={submit} className="space-y-4">
        <Field label="Nom de l’étape">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Page de vente" />
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Type de page</p>
          <TypePicker value={type} onChange={setType} />
        </div>
        {open && <StepTemplatePicker value={tpl} funnelKit={funnelKit} onChange={(id, stepType) => { setTpl(id); if (stepType) setType(stepType); }} />}
      </form>
    </Modal>
  );
}

const TEMPLATE_BUILDERS: Record<string, () => PageContent> = {};

function StepTemplatePicker({ value, funnelKit, onChange }: { value: string; funnelKit: string | null; onChange: (id: string, type?: StepType) => void }) {
  const previews = usePageTemplatePreviews();
  // the kit of the funnel comes first; another kit can be picked, the classic templates stay available below
  const [kitId, setKitId] = useState<string>(funnelKit && getKit(funnelKit) ? funnelKit : KITS[0]!.id);
  const kit = getKit(kitId) ?? KITS[0]!;
  for (const p of previews) TEMPLATE_BUILDERS[p.t.id] = () => p.t.build();
  const Opt = ({ id, label, children, type }: { id: string; label: string; children: React.ReactNode; type?: StepType }) => (
    <button
      type="button"
      onClick={() => onChange(id, type)}
      className={cx('overflow-hidden rounded-lg border text-left transition-all', value === id ? 'border-brand-500 ring-4 ring-brand-500/15' : 'border-slate-200 hover:border-brand-300')}
    >
      {children}
      <span className="block truncate px-2 py-1.5 text-xs font-medium text-slate-700">{label}</span>
    </button>
  );
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-slate-700">
          Pages du kit {kit.name}
          {funnelKit === kit.id && <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">kit de ce tunnel</span>}
        </p>
        <label className="flex items-center gap-2 text-xs text-slate-500">
          Kit
          <select aria-label="Kit" value={kit.id} onChange={(e) => setKitId(e.target.value)} className="h-8 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-700">
            {KITS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
                {k.id === funnelKit ? ' (ce tunnel)' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mb-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
        {KIT_PAGE_KINDS.map((kind) => (
          <Opt key={kind} id={`kit:${kit.id}:${kind}`} label={KIT_PAGES[kind].name} type={KIT_PAGES[kind].stepType}>
            <DocThumb html={kitPagePreview(kit.id, kind)} width={190} ratio={0.6} />
          </Opt>
        ))}
      </div>
      <p className="mb-2 text-sm font-medium text-slate-700">Modèles classiques</p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        <Opt id="default" label={funnelKit ? 'Selon le type, dans le kit' : 'Modèle du type (par défaut)'}>
          <div className="flex h-[114px] items-center justify-center bg-brand-50 text-xs font-medium text-brand-700">Selon le type</div>
        </Opt>
        {previews.map((p) => (
          <Opt key={p.t.id} id={p.t.id} label={p.t.name} type={p.t.stepType}>
            <DocThumb html={p.html} width={190} ratio={0.6} />
          </Opt>
        ))}
        <Opt id="blank" label="Page vierge">
          <div className="flex h-[114px] items-center justify-center bg-slate-50 text-xs text-slate-400">Vide</div>
        </Opt>
      </div>
    </div>
  );
}

function StepSettingsModal({ step, funnelSlug, onClose, onSaved }: { step: Step | null; funnelSlug: string; onClose: () => void; onSaved: (s: Step) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [type, setType] = useState<StepType>('custom');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (step) {
      setName(step.name);
      setSlug(step.slug);
      setType(step.type);
    }
  }, [step]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!step) return;
    setSaving(true);
    try {
      const s = await api.updateStep(step.id, { name: name.trim(), slug: slugify(slug), type });
      toast.success('Étape mise à jour');
      onSaved(s);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!step}
      onClose={onClose}
      title="Paramètres de l’étape"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="step-settings" loading={saving}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="step-settings" onSubmit={submit} className="space-y-4">
        <Field label="Nom">
          <Input required value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Adresse (slug)" hint={`${window.location.origin}/p/${funnelSlug}/${slugify(slug) || '…'}`}>
          <Input required value={slug} onChange={(e) => setSlug(e.target.value)} onBlur={() => setSlug(slugify(slug))} />
        </Field>
        <div>
          <p className="mb-2 text-sm font-medium text-slate-700">Type</p>
          <TypePicker value={type} onChange={setType} />
          <p className="mt-2 text-xs text-slate-500">Changer le type ne modifie pas le contenu de la page.</p>
        </div>
      </form>
    </Modal>
  );
}

// /automations/:id: visual flow editor — trigger → conditions → actions on a canvas. Blocks are dragged from the palette
// (or moved within the flow) onto the drop points between nodes; the right panel edits the selected block.
// The data model is unchanged: `actions` stays an ordered list (≤ 20), executed top to bottom.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDndContext,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  ArrowLeft,
  CircleStop,
  Clock,
  Copy,
  Filter,
  GripVertical,
  KeyRound,
  Mail,
  MailMinus,
  MailX,
  PenLine,
  Plus,
  RefreshCw,
  Settings2,
  Tag,
  TagsIcon,
  Trash,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import {
  AUTOMATION_ACTION_LABELS,
  AUTOMATION_TRIGGER_LABELS,
  emptyFilter,
  type Automation,
  type AutomationAction,
  type AutomationActionType,
  type AutomationTrigger,
  type AutomationTriggerType,
  type SegmentFilter,
  type Step,
} from '@scalo/shared';
import { api } from '../../lib/api';
import { crmApi } from '../../lib/crm-api';
import { useCrmRefs, type CrmRefs } from '../../lib/crm-refs';
import { CourseTriggerField } from '../courses/CourseTriggerField';
import { copyText, useBeforeUnload, useLoad } from '../../lib/hooks';
import { Button, CardHeader, cx, ErrorState, Field, Input, PageLoader, Select, Tabs, Toggle } from '../../components/ui';
import { DropdownMenu } from '../../components/Menu';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { FilterBuilder, isFilterComplete } from '../../components/FilterBuilder';
import { useFilterCount } from '../contacts/SegmentsTab';
import { RunsTable } from './RunsTable';
import { isoToLocalInput, localInputToIso } from '../../lib/format';
import { describeAction, describeTrigger } from './labels';

interface Draft {
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: SegmentFilter | null;
  actions: AutomationAction[];
  run_once: boolean;
}

const toDraft = (a: Automation): Draft => ({ name: a.name, enabled: a.enabled, trigger: a.trigger, conditions: a.conditions, actions: a.actions, run_once: a.run_once });

const MAX_ACTIONS = 20;

/** Look of each action block, and where it sits in the palette. */
const ACTION_META: Record<AutomationActionType, { icon: LucideIcon; tone: string; group: string; hint: string }> = {
  add_tag: { icon: Tag, tone: 'bg-brand-50 text-brand-600', group: 'Contact', hint: 'Segmentez vos contacts' },
  remove_tag: { icon: TagsIcon, tone: 'bg-brand-50 text-brand-600', group: 'Contact', hint: 'Nettoyez un tag' },
  set_field: { icon: PenLine, tone: 'bg-brand-50 text-brand-600', group: 'Contact', hint: 'Renseignez un champ' },
  enroll: { icon: Mail, tone: 'bg-emerald-50 text-emerald-600', group: 'Emails', hint: 'Démarrez une séquence' },
  unenroll: { icon: MailMinus, tone: 'bg-emerald-50 text-emerald-600', group: 'Emails', hint: 'Arrêtez une séquence' },
  unsubscribe: { icon: MailX, tone: 'bg-rose-50 text-rose-600', group: 'Emails', hint: 'Plus aucun email' },
  wait: { icon: Clock, tone: 'bg-amber-50 text-amber-600', group: 'Temps', hint: 'Minutes, heures ou jours' },
  webhook: { icon: Webhook, tone: 'bg-slate-100 text-slate-600', group: 'Intégrations', hint: 'Prévenez un autre outil' },
};
const GROUPS = ['Contact', 'Emails', 'Temps', 'Intégrations'];
const ACTION_TYPES = Object.keys(AUTOMATION_ACTION_LABELS) as AutomationActionType[];

let seq = 0;
const uid = () => `n${++seq}`;

type Selection = { kind: 'trigger' } | { kind: 'conditions' } | { kind: 'action'; key: string } | null;

export function AutomationEditorPage() {
  const { id } = useParams();
  const automationId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: a, setData, error, loading, reload } = useLoad(() => crmApi.automation(automationId), [automationId]);
  const { refs } = useCrmRefs({ broadcasts: true });
  const [draft, setDraft] = useState<Draft | null>(null);
  // stable ids for the action blocks (drag and drop, selection); kept parallel to draft.actions
  const [keys, setKeys] = useState<string[]>([]);
  const [sel, setSel] = useState<Selection>({ kind: 'trigger' });
  const [panel, setPanel] = useState<'block' | 'runs'>('block');
  const [dragging, setDragging] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [runsKey, setRunsKey] = useState(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));

  useEffect(() => {
    if (!a) return;
    setDraft(toDraft(a));
    setKeys(a.actions.map(uid));
  }, [a]);

  const dirty = !!a && !!draft && JSON.stringify(toDraft(a)) !== JSON.stringify(draft);
  useBeforeUnload(dirty);

  if (loading && !a) return <PageLoader />;
  if (error && !a) return <ErrorState message={error} onRetry={reload} />;
  if (!a || !draft) return null;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const complete = actionsComplete(draft.actions) && (!draft.conditions || isFilterComplete(draft.conditions)) && triggerComplete(draft.trigger);

  // ---- flow operations (actions + keys move together)
  const insertAt = (index: number, action: AutomationAction) => {
    if (draft.actions.length >= MAX_ACTIONS) return toast.error(`${MAX_ACTIONS} actions au maximum`);
    const k = uid();
    const actions = draft.actions.slice();
    const ks = keys.slice();
    actions.splice(index, 0, action);
    ks.splice(index, 0, k);
    set({ actions });
    setKeys(ks);
    setSel({ kind: 'action', key: k });
    setPanel('block');
  };
  const move = (from: number, to: number) => {
    const actions = draft.actions.slice();
    const ks = keys.slice();
    const [x] = actions.splice(from, 1);
    const [k] = ks.splice(from, 1);
    actions.splice(to, 0, x);
    ks.splice(to, 0, k);
    set({ actions });
    setKeys(ks);
  };
  const removeAt = (i: number) => {
    set({ actions: draft.actions.filter((_, k) => k !== i) });
    setKeys(keys.filter((_, k) => k !== i));
    setSel(null);
  };
  const updateAt = (i: number, action: AutomationAction) => set({ actions: draft.actions.map((x, k) => (k === i ? action : x)) });

  const onDragStart = (e: DragStartEvent) => setDragging(String(e.active.id));
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over) return;
    const aid = String(active.id);
    const oid = String(over.id);
    if (!oid.startsWith('slot:')) return;
    const target = Number(oid.slice(5));
    if (aid.startsWith('palette:')) return insertAt(target, defaultAction(aid.slice(8) as AutomationActionType, refs));
    const from = keys.indexOf(aid);
    if (from < 0) return;
    const to = target > from ? target - 1 : target;
    if (to !== from) move(from, to);
  };

  const save = async (patch: Partial<Draft> = {}) => {
    const next = { ...draft, ...patch };
    setSaving(true);
    try {
      const saved = await crmApi.updateAutomation(a.id, {
        ...next,
        conditions: next.conditions && next.conditions.conditions.length ? next.conditions : null,
      });
      setData(saved);
      setRunsKey((k) => k + 1);
      toast.success(patch.enabled !== undefined ? (patch.enabled ? 'Automatisation activée' : 'Automatisation désactivée') : 'Automatisation enregistrée');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Supprimer « ${a.name} » ?`,
      message: 'L’automatisation et son journal sont supprimés. Les exécutions en attente sont annulées ; les actions déjà faites restent.',
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await crmApi.deleteAutomation(a.id);
      toast.success('Automatisation supprimée');
      navigate('/automations');
    } catch (err) {
      toast.error(err);
    }
  };

  const rotate = async (which: 'webhook' | 'signing') => {
    const ok = await confirm({
      title: which === 'webhook' ? 'Générer une nouvelle URL ?' : 'Générer un nouveau secret de signature ?',
      message: which === 'webhook' ? 'L’URL actuelle cessera immédiatement de fonctionner.' : 'Les signatures seront calculées avec le nouveau secret : mettez à jour le service qui les vérifie.',
      confirmLabel: 'Régénérer',
      tone: 'primary',
    });
    if (!ok) return;
    try {
      setData(await crmApi.rotateAutomationSecret(a.id, which));
      toast.success('Nouveau secret généré');
    } catch (err) {
      toast.error(err);
    }
  };

  const selIndex = sel?.kind === 'action' ? keys.indexOf(sel.key) : -1;
  const draggedType: AutomationActionType | null = dragging
    ? dragging.startsWith('palette:')
      ? (dragging.slice(8) as AutomationActionType)
      : draft.actions[keys.indexOf(dragging)]?.type ?? null
    : null;

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <Link to="/automations" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-ink">
        <ArrowLeft size={16} /> Automatisations
      </Link>
      <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <input
          className="min-w-0 flex-1 truncate rounded-xl border border-transparent bg-transparent px-1 font-display text-[28px] font-extrabold tracking-[-0.03em] text-ink outline-none hover:border-slate-200 focus:border-brand-500"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          aria-label="Nom de l’automatisation"
          maxLength={120}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Toggle checked={a.enabled} onChange={(v) => (dirty ? toast.error('Enregistrez d’abord vos modifications') : save({ enabled: v }))} label={a.enabled ? 'Active' : 'Désactivée'} />
          <Button variant="secondary" icon={Trash} className="text-rose-600 hover:text-rose-700" onClick={remove}>
            Supprimer
          </Button>
          <Button onClick={() => save()} loading={saving} disabled={!dirty || !complete || !draft.name.trim()}>
            Enregistrer
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)_360px]">
        <Palette onAdd={(t) => insertAt(draft.actions.length, defaultAction(t, refs))} full={draft.actions.length >= MAX_ACTIONS} />

        {/* canvas */}
        <div
          className="relative min-h-[640px] overflow-x-auto rounded-3xl border border-slate-200/80 bg-white bg-[radial-gradient(#e2defe_1.2px,transparent_1.2px)] [background-size:22px_22px] px-4 py-10"
          onClick={(e) => e.target === e.currentTarget && setSel(null)}
        >
          <div className="mx-auto flex w-full max-w-[380px] flex-col items-center">
            <TriggerNode
              trigger={draft.trigger}
              refs={refs}
              selected={sel?.kind === 'trigger'}
              incomplete={!triggerComplete(draft.trigger)}
              onClick={() => (setSel({ kind: 'trigger' }), setPanel('block'))}
            />
            <Connector />
            {draft.conditions ? (
              <>
                <FlowCard
                  icon={Filter}
                  tone="bg-violet-50 text-violet-600"
                  kicker="Conditions"
                  title={`${draft.conditions.conditions.length || 'Aucune'} condition${draft.conditions.conditions.length > 1 ? 's' : ''}`}
                  summary="Le contact doit correspondre au filtre"
                  selected={sel?.kind === 'conditions'}
                  incomplete={!isFilterComplete(draft.conditions)}
                  onClick={() => (setSel({ kind: 'conditions' }), setPanel('block'))}
                />
                <Connector />
              </>
            ) : (
              <>
                <button
                  className="rounded-full border border-dashed border-violet-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-violet-600 hover:bg-violet-50"
                  onClick={() => {
                    set({ conditions: emptyFilter() });
                    setSel({ kind: 'conditions' });
                    setPanel('block');
                  }}
                >
                  <Filter size={12} className="mr-1 inline" /> Ajouter des conditions
                </button>
                <Connector />
              </>
            )}

            <Slot index={0} onInsert={(t) => insertAt(0, defaultAction(t, refs))} disabled={draft.actions.length >= MAX_ACTIONS} />
            {draft.actions.map((action, i) => (
              <div key={keys[i]} className="flex w-full flex-col items-center">
                <ActionNode
                  id={keys[i]}
                  index={i}
                  action={action}
                  refs={refs}
                  selected={sel?.kind === 'action' && sel.key === keys[i]}
                  onClick={() => (setSel({ kind: 'action', key: keys[i] }), setPanel('block'))}
                />
                <Slot index={i + 1} onInsert={(t) => insertAt(i + 1, defaultAction(t, refs))} disabled={draft.actions.length >= MAX_ACTIONS} />
              </div>
            ))}
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-3.5 py-1.5 text-xs font-semibold text-slate-500">
              <CircleStop size={13} /> Fin
            </span>
            {draft.actions.length === 0 && (
              <p className="mt-6 max-w-[280px] text-center text-sm text-slate-500">Glissez un bloc depuis la palette, ou cliquez sur « + » pour ajouter la première action.</p>
            )}
          </div>
        </div>

        {/* inspector */}
        <aside className="self-start rounded-3xl border border-slate-200/80 bg-white p-5 xl:sticky xl:top-6">
          <Tabs
            className="mb-5"
            value={panel}
            onChange={setPanel}
            tabs={[
              { id: 'block', label: sel ? 'Bloc sélectionné' : 'Réglages', icon: Settings2 },
              { id: 'runs', label: 'Journal' },
            ]}
          />
          {panel === 'runs' ? (
            <RunsTable automationId={a.id} refreshKey={runsKey} />
          ) : sel?.kind === 'trigger' ? (
            <InspectorBlock icon={Zap} tone="bg-ink text-lime-400" title="Déclencheur" description="Ce qui lance l’automatisation pour un contact.">
              <TriggerEditor trigger={draft.trigger} onChange={(trigger) => set({ trigger })} refs={refs} automation={a} onRotate={() => rotate('webhook')} />
            </InspectorBlock>
          ) : sel?.kind === 'conditions' && draft.conditions ? (
            <InspectorBlock icon={Filter} tone="bg-violet-50 text-violet-600" title="Conditions" description="Vérifiées quand l’exécution démarre.">
              <ConditionsEditor filter={draft.conditions} onChange={(conditions) => set({ conditions })} refs={refs} />
              <Button
                size="sm"
                variant="ghost"
                icon={Trash}
                className="mt-4 text-rose-600"
                onClick={() => {
                  set({ conditions: null });
                  setSel(null);
                }}
              >
                Retirer les conditions
              </Button>
            </InspectorBlock>
          ) : selIndex >= 0 ? (
            <ActionInspector
              index={selIndex}
              action={draft.actions[selIndex]}
              refs={refs}
              onChange={(x) => updateAt(selIndex, x)}
              onRemove={() => removeAt(selIndex)}
              onDuplicate={() => insertAt(selIndex + 1, structuredClone(draft.actions[selIndex]))}
              signing={draft.actions[selIndex].type === 'webhook' ? <SigningSecret secret={a.signing_secret} onRotate={() => rotate('signing')} /> : null}
            />
          ) : (
            <div className="space-y-5">
              <Toggle
                checked={draft.run_once}
                onChange={(run_once) => set({ run_once })}
                label="Une seule fois par contact"
                description="Si le déclencheur se reproduit pour un contact déjà passé par cette automatisation, rien n’est exécuté."
              />
              <p className="rounded-2xl bg-brand-50 p-3 text-xs leading-relaxed text-brand-800">
                Les actions s’exécutent de haut en bas, en arrière-plan. Protection contre les boucles : une automatisation ne se redéclenche pas elle-même pour le même contact
                dans une même chaîne, et une chaîne s’arrête après 5 niveaux.
              </p>
              <p className="text-sm text-slate-500">Cliquez sur un bloc du flux pour le modifier.</p>
            </div>
          )}
        </aside>
      </div>

      <DragOverlay dropAnimation={null}>{draggedType ? <PaletteChip type={draggedType} lifted /> : null}</DragOverlay>
    </DndContext>
  );
}

// ---------- canvas pieces ----------

function Connector() {
  return <span className="h-6 w-0.5 rounded-full bg-brand-200" aria-hidden="true" />;
}

/** Drop point between two blocks; also a "+" button to insert by click. */
function Slot({ index, onInsert, disabled }: { index: number; onInsert: (t: AutomationActionType) => void; disabled: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `slot:${index}`, disabled });
  const { active } = useDndContext();
  return (
    <div ref={setNodeRef} className="flex w-full flex-col items-center">
      {active && !disabled ? (
        <div
          className={cx(
            'my-1 flex h-14 w-full items-center justify-center rounded-2xl border-2 border-dashed text-xs font-semibold transition-colors',
            isOver ? 'border-brand-500 bg-brand-50 text-brand-600' : 'border-brand-200 text-brand-300',
          )}
        >
          Déposer ici
        </div>
      ) : (
        <>
          <span className="h-3 w-0.5 rounded-full bg-brand-200" aria-hidden="true" />
          <DropdownMenu
            align="start"
            width={250}
            trigger={({ toggle, ref }) => (
              <button
                ref={ref as never}
                onClick={toggle}
                disabled={disabled}
                aria-label="Ajouter une action ici"
                className="flex h-7 w-7 items-center justify-center rounded-full border border-brand-200 bg-white text-brand-500 transition hover:scale-110 hover:border-brand-500 hover:bg-brand-500 hover:text-white disabled:opacity-40"
              >
                <Plus size={15} strokeWidth={2.5} />
              </button>
            )}
            items={GROUPS.flatMap((g, gi) => [
              ...(gi ? (['sep'] as const) : []),
              { heading: g },
              ...ACTION_TYPES.filter((t) => ACTION_META[t].group === g).map((t) => ({ label: AUTOMATION_ACTION_LABELS[t], icon: ACTION_META[t].icon, onClick: () => onInsert(t) })),
            ])}
          />
          <span className="h-3 w-0.5 rounded-full bg-brand-200" aria-hidden="true" />
        </>
      )}
    </div>
  );
}

function FlowCard({
  icon: Icon,
  tone,
  kicker,
  title,
  summary,
  selected,
  incomplete,
  onClick,
  dark,
  handle,
}: {
  icon: LucideIcon;
  tone: string;
  kicker: string;
  title: ReactNode;
  summary?: ReactNode;
  selected?: boolean;
  incomplete?: boolean;
  onClick: () => void;
  dark?: boolean;
  handle?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'group relative flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left shadow-card transition',
        dark ? 'border-ink bg-ink text-white' : 'border-slate-200 bg-white hover:border-brand-300',
        selected && 'ring-2 ring-brand-500 ring-offset-2',
      )}
    >
      <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-xl', tone)}>
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cx('block text-[11px] font-semibold', dark ? 'text-lime-400' : 'text-slate-400')}>{kicker}</span>
        <span className={cx('block truncate text-sm font-semibold', dark ? 'text-white' : 'text-ink')}>{title}</span>
        {summary && <span className={cx('block truncate text-xs', dark ? 'text-brand-200' : 'text-slate-500')}>{summary}</span>}
      </span>
      {incomplete && <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">À compléter</span>}
      {handle}
    </button>
  );
}

function TriggerNode({ trigger, refs, selected, incomplete, onClick }: { trigger: AutomationTrigger; refs: CrmRefs; selected: boolean; incomplete: boolean; onClick: () => void }) {
  return (
    <FlowCard
      dark
      icon={Zap}
      tone="bg-lime-400 text-ink"
      kicker="Quand…"
      title={AUTOMATION_TRIGGER_LABELS[trigger.type]}
      summary={describeTrigger(trigger, refs)}
      selected={selected}
      incomplete={incomplete}
      onClick={onClick}
    />
  );
}

function ActionNode({ id, index, action, refs, selected, onClick }: { id: string; index: number; action: AutomationAction; refs: CrmRefs; selected: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id });
  const meta = ACTION_META[action.type];
  const incomplete = !actionsComplete([action]);
  return (
    <div ref={setNodeRef} {...attributes} {...listeners} className={cx('w-full touch-none', isDragging && 'opacity-30')}>
      {action.type === 'wait' ? (
        // waits read as a pause in the flow: a pill rather than a card
        <button
          type="button"
          onClick={onClick}
          className={cx(
            'mx-auto flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 py-2 pr-4 pl-2 text-sm font-semibold text-amber-900 shadow-card',
            selected && 'ring-2 ring-brand-500 ring-offset-2',
          )}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-amber-600">
            <Clock size={15} />
          </span>
          {describeAction(action, refs)}
          <GripVertical size={14} className="ml-1 text-amber-400" />
        </button>
      ) : (
        <FlowCard
          icon={meta.icon}
          tone={meta.tone}
          kicker={`Étape ${index + 1}`}
          title={AUTOMATION_ACTION_LABELS[action.type]}
          summary={describeAction(action, refs)}
          selected={selected}
          incomplete={incomplete}
          onClick={onClick}
          handle={<GripVertical size={16} className="shrink-0 text-slate-300 group-hover:text-slate-500" />}
        />
      )}
    </div>
  );
}

// ---------- palette ----------

function PaletteChip({ type, lifted }: { type: AutomationActionType; lifted?: boolean }) {
  const meta = ACTION_META[type];
  return (
    <span className={cx('flex w-full items-center gap-2.5 rounded-xl border border-slate-200 bg-white p-2 text-left', lifted ? 'w-[220px] rotate-2 shadow-pop' : 'hover:border-brand-300')}>
      <span className={cx('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', meta.tone)}>
        <meta.icon size={15} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-semibold text-ink">{AUTOMATION_ACTION_LABELS[type]}</span>
        <span className="block truncate text-[11px] text-slate-500">{meta.hint}</span>
      </span>
    </span>
  );
}

function PaletteItem({ type, onAdd, disabled }: { type: AutomationActionType; onAdd: () => void; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette:${type}`, disabled });
  return (
    <button ref={setNodeRef} type="button" {...attributes} {...listeners} onClick={onAdd} disabled={disabled} className={cx('block w-full cursor-grab touch-none disabled:opacity-40', isDragging && 'opacity-40')}>
      <PaletteChip type={type} />
    </button>
  );
}

function Palette({ onAdd, full }: { onAdd: (t: AutomationActionType) => void; full: boolean }) {
  return (
    <aside className="self-start rounded-3xl border border-slate-200/80 bg-white p-4 xl:sticky xl:top-6">
      <p className="font-display text-sm font-extrabold text-ink">Blocs</p>
      <p className="mb-3 text-xs text-slate-500">Glissez-les dans le flux, ou cliquez pour ajouter à la fin.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
        {GROUPS.map((g) => (
          <div key={g}>
            <p className="mb-1.5 text-[11px] font-semibold text-slate-400">{g}</p>
            <div className="space-y-1.5">
              {ACTION_TYPES.filter((t) => ACTION_META[t].group === g).map((t) => (
                <PaletteItem key={t} type={t} onAdd={() => onAdd(t)} disabled={full} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ---------- inspector ----------

function InspectorBlock({ icon: Icon, tone, title, description, children }: { icon: LucideIcon; tone: string; title: string; description: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-4 flex items-start gap-3">
        <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', tone)}>
          <Icon size={17} />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-base font-extrabold tracking-[-0.01em] text-ink">{title}</h3>
          <p className="text-sm text-slate-500">{description}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function ActionInspector({
  index,
  action,
  refs,
  onChange,
  onRemove,
  onDuplicate,
  signing,
}: {
  index: number;
  action: AutomationAction;
  refs: CrmRefs;
  onChange: (a: AutomationAction) => void;
  onRemove: () => void;
  onDuplicate: () => void;
  signing: ReactNode;
}) {
  const meta = ACTION_META[action.type];
  return (
    <InspectorBlock icon={meta.icon} tone={meta.tone} title={AUTOMATION_ACTION_LABELS[action.type]} description={`Étape ${index + 1} du flux`}>
      <div className="space-y-4">
        <Field label="Type de bloc">
          <Select value={action.type} onChange={(e) => onChange(defaultAction(e.target.value as AutomationActionType, refs))}>
            {ACTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {AUTOMATION_ACTION_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Réglage">
          <ActionFields a={action} onChange={onChange} refs={refs} />
        </Field>
        {signing}
        <div className="flex gap-2 border-t border-slate-100 pt-4">
          <Button size="sm" variant="secondary" icon={Copy} onClick={onDuplicate}>
            Dupliquer
          </Button>
          <Button size="sm" variant="ghost" icon={Trash} className="text-rose-600" onClick={onRemove}>
            Supprimer
          </Button>
        </div>
      </div>
    </InspectorBlock>
  );
}

// ---------- trigger ----------

function triggerComplete(t: AutomationTrigger) {
  return (t.type !== 'tag_added' && t.type !== 'tag_removed') || t.tag_id > 0;
}

function CopyField({ value, label }: { value: string; label: string }) {
  const toast = useToast();
  return (
    <div className="flex gap-2">
      <Input readOnly value={value} className="flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} aria-label={label} />
      <Button variant="secondary" icon={Copy} onClick={async () => (await copyText(value)) && toast.success('Copié')}>
        Copier
      </Button>
    </div>
  );
}

function TriggerEditor({ trigger, onChange, refs, automation, onRotate }: { trigger: AutomationTrigger; onChange: (t: AutomationTrigger) => void; refs: CrmRefs; automation: Automation; onRotate: () => void }) {
  const funnelId = trigger.type === 'optin' ? trigger.funnel_id ?? null : null;
  const [steps, setSteps] = useState<Step[]>([]);
  useEffect(() => {
    if (!funnelId) return setSteps([]);
    let alive = true;
    api
      .funnel(funnelId)
      .then((f) => alive && setSteps(f.steps ?? []))
      .catch(() => alive && setSteps([]));
    return () => {
      alive = false;
    };
  }, [funnelId]);

  const changeType = (type: AutomationTriggerType) => {
    if (type === 'tag_added' || type === 'tag_removed') onChange({ type, tag_id: trigger.type === 'tag_added' || trigger.type === 'tag_removed' ? trigger.tag_id : refs.tags[0]?.id ?? 0 });
    else onChange({ type } as AutomationTrigger);
  };

  return (
    <div className="space-y-4">
      <Field label="Quand">
        <Select value={trigger.type} onChange={(e) => changeType(e.target.value as AutomationTriggerType)}>
          {(Object.keys(AUTOMATION_TRIGGER_LABELS) as AutomationTriggerType[]).map((t) => (
            <option key={t} value={t}>
              {AUTOMATION_TRIGGER_LABELS[t]}
            </option>
          ))}
        </Select>
      </Field>
      {(trigger.type === 'tag_added' || trigger.type === 'tag_removed') && (
        <Field label="Tag">
          <TagSelect value={trigger.tag_id} onChange={(tag_id) => onChange({ ...trigger, tag_id })} refs={refs} />
        </Field>
      )}
      {trigger.type === 'optin' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tunnel" hint="Double opt-in : déclenché à la confirmation.">
            <Select value={trigger.funnel_id ?? ''} onChange={(e) => onChange({ ...trigger, funnel_id: e.target.value ? Number(e.target.value) : null, step_id: null })}>
              <option value="">Tous les tunnels</option>
              {refs.funnels.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Étape">
            <Select value={trigger.step_id ?? ''} disabled={!trigger.funnel_id} onChange={(e) => onChange({ ...trigger, step_id: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Toutes les étapes</option>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}
      {trigger.type === 'link_clicked' && (
        <div className="space-y-4">
          <Field label="L’URL contient (facultatif)" hint="ex. /offre ou monsite.com/webinar">
            <Input value={trigger.url_contains ?? ''} onChange={(e) => onChange({ ...trigger, url_contains: e.target.value })} placeholder="n’importe quel lien" />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Newsletter (facultatif)">
              <Select value={trigger.broadcast_id ?? ''} onChange={(e) => onChange({ ...trigger, broadcast_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Toutes</option>
                {refs.broadcasts.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.subject}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Campagne (facultatif)">
              <Select value={trigger.campaign_id ?? ''} onChange={(e) => onChange({ ...trigger, campaign_id: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Toutes</option>
                {refs.campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      )}
      {trigger.type === 'purchase' && (
        <Field label="Produit (facultatif)" hint="Nom exact (sans tenir compte des majuscules). Les achats viennent des commandes payées dans vos tunnels (nom du produit vendu), de l’API publique (POST /api/v1/purchases) ou d’un webhook entrant.">
          <Input value={trigger.product ?? ''} onChange={(e) => onChange({ ...trigger, product: e.target.value })} placeholder="tous les produits" />
        </Field>
      )}
      {trigger.type === 'campaign_completed' && (
        <Field label="Campagne" hint="Quand le contact a reçu (ou passé) le dernier email de la séquence.">
          <Select value={trigger.campaign_id ?? ''} onChange={(e) => onChange({ ...trigger, campaign_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Toutes les campagnes</option>
            {refs.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {trigger.type === 'course_completed' && <CourseTriggerField value={trigger.course_id ?? null} onChange={(course_id) => onChange({ ...trigger, course_id })} />}
      {trigger.type === 'contact_created' && <p className="text-sm text-slate-500">Tout nouveau contact : formulaire, import CSV, ajout manuel, API ou webhook.</p>}
      {trigger.type === 'affiliate_approved' && <p className="text-sm text-slate-500">Un contact devient affilié approuvé : inscription ouverte, validation d’une demande ou ajout manuel (une seule fois par affilié).</p>}
      {trigger.type === 'webhook' &&
        (automation.webhook_url && automation.trigger.type === 'webhook' ? (
          <div className="space-y-3">
            <Field label="URL du webhook (secrète)">
              <CopyField value={automation.webhook_url} label="URL du webhook" />
            </Field>
            <div className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
              <p>
                Envoyez un <code>POST</code> JSON ou formulaire avec au moins <code>email</code>. Champs reconnus : <code>first_name</code>, <code>last_name</code>, <code>phone</code>,{' '}
                <code>fields</code> (ou directement la clé d’un champ personnalisé), et pour un achat <code>product</code>, <code>amount</code>, <code>currency</code>, <code>external_id</code>.
                Le contact est créé ou mis à jour, puis les actions s’exécutent. Limite : 60 appels / minute.
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-[11px] text-slate-100">{`curl -X POST '${automation.webhook_url}' \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"marie@exemple.com","first_name":"Marie","product":"Formation","amount":97}'`}</pre>
            </div>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onRotate}>
              Générer une nouvelle URL
            </Button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Enregistrez pour obtenir l’URL secrète du webhook.</p>
        ))}
    </div>
  );
}

// ---------- conditions ----------

function ConditionsEditor({ filter, onChange, refs }: { filter: SegmentFilter; onChange: (f: SegmentFilter) => void; refs: CrmRefs }) {
  const count = useFilterCount(filter, filter.conditions.length > 0);
  return (
    <div className="space-y-3">
      {refs.segments.length > 0 && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span>Partir d’un segment :</span>
          <Select
            className="w-56"
            value=""
            onChange={(e) => {
              const s = refs.segments.find((x) => String(x.id) === e.target.value);
              if (s) onChange(s.filter);
            }}
          >
            <option value="">Choisir…</option>
            {refs.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <FilterBuilder value={filter} onChange={onChange} refs={refs} />
      {filter.conditions.length > 0 && count !== null && (
        <p className="text-xs text-slate-500">
          {count} contact{count > 1 ? 's' : ''} rempli{count > 1 ? 'ssent' : 't'} ces conditions aujourd’hui.
        </p>
      )}
    </div>
  );
}

// ---------- actions ----------

function actionsComplete(actions: AutomationAction[]) {
  return actions.every((a) => {
    switch (a.type) {
      case 'add_tag':
      case 'remove_tag':
        return a.tag_id > 0;
      case 'enroll':
      case 'unenroll':
        return a.campaign_id > 0;
      case 'set_field':
        return !!a.key;
      case 'webhook':
        return /^https:\/\/.+/.test(a.url);
      case 'wait':
        return a.amount >= 1;
      default:
        return true;
    }
  });
}

function defaultAction(type: AutomationActionType, refs: CrmRefs): AutomationAction {
  switch (type) {
    case 'add_tag':
    case 'remove_tag':
      return { type, tag_id: refs.tags[0]?.id ?? 0 };
    case 'enroll':
    case 'unenroll':
      return { type, campaign_id: refs.campaigns[0]?.id ?? 0 };
    case 'set_field': {
      const f = refs.fields[0];
      return { type, key: f?.key ?? '', value: f?.type === 'checkbox' ? true : '' };
    }
    case 'webhook':
      return { type, url: 'https://' };
    case 'wait':
      return { type, amount: 1, unit: 'days' };
    default:
      return { type: 'unsubscribe' };
  }
}

function TagSelect({ value, onChange, refs }: { value: number; onChange: (id: number) => void; refs: CrmRefs }) {
  return (
    <Select value={value || ''} onChange={(e) => onChange(Number(e.target.value))}>
      <option value="">Choisir un tag…</option>
      {refs.tags.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </Select>
  );
}

function ActionFields({ a, onChange, refs }: { a: AutomationAction; onChange: (a: AutomationAction) => void; refs: CrmRefs }) {
  switch (a.type) {
    case 'add_tag':
    case 'remove_tag':
      return <TagSelect value={a.tag_id} onChange={(tag_id) => onChange({ ...a, tag_id })} refs={refs} />;
    case 'enroll':
    case 'unenroll':
      return (
        <Select value={a.campaign_id || ''} onChange={(e) => onChange({ ...a, campaign_id: Number(e.target.value) })}>
          <option value="">Choisir une campagne…</option>
          {refs.campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      );
    case 'set_field': {
      const f = refs.fields.find((x) => x.key === a.key);
      return (
        <div className="flex flex-wrap gap-2">
          <Select className="w-48" value={a.key} onChange={(e) => {
            const nf = refs.fields.find((x) => x.key === e.target.value);
            onChange({ ...a, key: e.target.value, value: nf?.type === 'checkbox' ? true : '' });
          }}>
            {!refs.fields.length && <option value="">Aucun champ personnalisé</option>}
            {refs.fields.map((x) => (
              <option key={x.key} value={x.key}>
                {x.label}
              </option>
            ))}
          </Select>
          {f?.type === 'checkbox' ? (
            <Select className="w-36" value={a.value === false ? 'false' : 'true'} onChange={(e) => onChange({ ...a, value: e.target.value === 'true' })}>
              <option value="true">Coché</option>
              <option value="false">Non coché</option>
            </Select>
          ) : f?.type === 'select' ? (
            <Select className="min-w-36 flex-1" value={String(a.value ?? '')} onChange={(e) => onChange({ ...a, value: e.target.value || null })}>
              <option value="">(vider le champ)</option>
              {f.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : f?.type === 'datetime' ? (
            <Input
              className="min-w-44 flex-1"
              type="datetime-local"
              aria-label={f.label}
              value={isoToLocalInput(typeof a.value === 'string' ? a.value : '')}
              onChange={(e) => onChange({ ...a, value: localInputToIso(e.target.value) || null })}
            />
          ) : (
            <Input
              className="min-w-36 flex-1"
              type={f?.type === 'number' ? 'number' : f?.type === 'date' ? 'date' : 'text'}
              value={String(a.value ?? '')}
              placeholder="Valeur (vide = effacer)"
              onChange={(e) => onChange({ ...a, value: f?.type === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value || null })}
            />
          )}
        </div>
      );
    }
    case 'webhook':
      return <Input value={a.url} onChange={(e) => onChange({ ...a, url: e.target.value.trim() })} placeholder="https://exemple.com/webhook" className="font-mono text-xs" />;
    case 'wait':
      return (
        <div className="flex gap-2">
          <Input className="w-24" type="number" min={1} max={365} value={String(a.amount)} onChange={(e) => onChange({ ...a, amount: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
          <Select className="w-36" value={a.unit} onChange={(e) => onChange({ ...a, unit: e.target.value as 'days' })}>
            <option value="minutes">minute(s)</option>
            <option value="hours">heure(s)</option>
            <option value="days">jour(s)</option>
          </Select>
        </div>
      );
    default:
      return <p className="pt-2 text-sm text-slate-500">Le contact ne recevra plus aucun email (campagnes en cours arrêtées).</p>;
  }
}

function SigningSecret({ secret, onRotate }: { secret: string; onRotate: () => void }) {
  const [show, setShow] = useState(false);
  const masked = useMemo(() => `${secret.slice(0, 8)}${'•'.repeat(16)}`, [secret]);
  return (
    <div className="mt-4 rounded-lg border border-slate-200 p-3">
      <CardHeader title="Signature des webhooks" icon={KeyRound} description="Chaque appel est un POST JSON signé : vérifiez-le côté serveur." />
      <div className="space-y-2">
        {show ? <CopyField value={secret} label="Secret de signature" /> : (
          <div className="flex gap-2">
            <Input readOnly value={masked} className="flex-1 font-mono text-xs" />
            <Button variant="secondary" onClick={() => setShow(true)}>
              Afficher
            </Button>
          </div>
        )}
        <p className="text-xs leading-relaxed text-slate-500">
          En-tête <code>X-Scalo-Signature: t=&lt;horodatage&gt;,v1=&lt;hex&gt;</code> où <code>v1 = HMAC-SHA256(secret, "&lt;t&gt;.&lt;corps brut&gt;")</code>. Refusez les horodatages trop anciens
          (&gt; 5 min). <code>X-Scalo-Delivery</code> identifie l’appel : il reste le même si l’appel est rejoué après une interruption. HTTPS uniquement, adresses privées refusées,
          délai 5 s, redirections non suivies.
        </p>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={onRotate}>
          Nouveau secret
        </Button>
      </div>
    </div>
  );
}

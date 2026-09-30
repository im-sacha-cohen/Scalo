// /automations: rules "déclencheur → conditions → actions" + global execution journal.
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowRight, History, Plus, Workflow, Zap } from 'lucide-react';
import { AUTOMATION_TRIGGER_LABELS, type Automation, type AutomationTrigger, type AutomationTriggerType } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import { useCrmRefs } from '../../lib/crm-refs';
import { useLoad } from '../../lib/hooks';
import { fmtNumber } from '../../lib/format';
import { Badge, cx, Button, Card, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs, Toggle } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { describeAction, describeTrigger } from './labels';
import { RunsTable } from './RunsTable';

export function AutomationsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'journal' ? 'journal' : 'rules';
  const [createOpen, setCreateOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Automatisations"
        description="Déclenchez des actions automatiquement : quand un contact s’inscrit, reçoit un tag, clique, achète… (conditions facultatives)."
        actions={
          <Button icon={Plus} onClick={() => setCreateOpen(true)}>
            Nouvelle automatisation
          </Button>
        }
      />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(t) => setParams(t === 'journal' ? { tab: 'journal' } : {}, { replace: true })}
        tabs={[
          { id: 'rules', label: 'Règles', icon: Workflow },
          { id: 'journal', label: 'Journal', icon: History },
        ]}
      />
      {tab === 'rules' ? <RulesList onCreate={() => setCreateOpen(true)} /> : <RunsTable automationId={null} showAutomation />}
      <CreateModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function RulesList({ onCreate }: { onCreate: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, reload, setData } = useLoad(() => crmApi.automations(), []);
  const { refs } = useCrmRefs({ broadcasts: true });

  const toggle = async (a: Automation, enabled: boolean) => {
    setData(data?.map((x) => (x.id === a.id ? { ...x, enabled } : x)));
    try {
      await crmApi.updateAutomation(a.id, { enabled });
      toast.success(enabled ? 'Automatisation activée' : 'Automatisation désactivée');
    } catch (err) {
      toast.error(err);
      reload();
    }
  };

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data)
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-xl" />
        ))}
      </div>
    );
  if (!data.length)
    return (
      <EmptyState
        icon={Zap}
        title="Laissez Scalo faire les gestes répétitifs"
        description="Une automatisation réagit à un événement et enchaîne les actions à votre place. Par exemple : quand un contact achète « Formation », ajouter le tag « client » et l’inscrire à la campagne d’accueil."
        action={
          <Button icon={Plus} onClick={onCreate}>
            Créer une automatisation
          </Button>
        }
      />
    );

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {data.map((a) => (
        <Card key={a.id} className="flex cursor-pointer flex-col gap-4 transition hover:border-brand-300 hover:shadow-card" padded>
          <div className="flex items-start justify-between gap-3" onClick={() => navigate(`/automations/${a.id}`)}>
            <div className="min-w-0">
              <h3 className="truncate font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{a.name}</h3>
              <p className="mt-2 inline-flex max-w-full items-center gap-2 rounded-full bg-ink py-1 pr-3 pl-1 text-xs font-medium text-white">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-lime-400 text-ink">
                  <Zap size={11} />
                </span>
                <span className="truncate">{describeTrigger(a.trigger, refs)}</span>
              </p>
            </div>
            <div onClick={(e) => e.stopPropagation()}>
              <Toggle checked={a.enabled} onChange={(v) => toggle(a, v)} />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500" onClick={() => navigate(`/automations/${a.id}`)}>
            {a.conditions && <Badge tone="violet">Conditions</Badge>}
            {a.actions.length === 0 ? (
              <span className="text-slate-400">Aucune action</span>
            ) : (
              a.actions.slice(0, 3).map((x, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && <ArrowRight size={12} className="text-brand-300" />}
                  <span className={cx('max-w-[180px] truncate rounded-full px-2.5 py-1 font-medium', x.type === 'wait' ? 'bg-amber-50 text-amber-800' : 'bg-brand-50 text-brand-700')}>
                    {describeAction(x, refs)}
                  </span>
                </span>
              ))
            )}
            {a.actions.length > 3 && <Badge>+{a.actions.length - 3}</Badge>}
          </div>
          <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs text-slate-500" onClick={() => navigate(`/automations/${a.id}`)}>
            <span>
              <strong className="text-slate-800 tabular-nums">{fmtNumber(a.stats?.runs_30d ?? 0)}</strong> exécutions (30 j)
            </span>
            {!!a.stats?.failed_30d && (
              <span className="text-rose-600">
                <strong className="tabular-nums">{fmtNumber(a.stats.failed_30d)}</strong> échec{a.stats.failed_30d > 1 ? 's' : ''}
              </span>
            )}
            {!!a.stats?.waiting && (
              <span className="text-amber-700">
                <strong className="tabular-nums">{fmtNumber(a.stats.waiting)}</strong> en attente
              </span>
            )}
            {!a.enabled && <span className="ml-auto text-slate-400">Désactivée</span>}
          </div>
        </Card>
      ))}
    </div>
  );
}

/** Minimal trigger for a new automation (parameters are completed in the editor). */
function defaultTrigger(type: AutomationTriggerType, tagId: number | undefined): AutomationTrigger | null {
  switch (type) {
    case 'tag_added':
    case 'tag_removed':
      return tagId ? { type, tag_id: tagId } : null;
    default:
      return { type } as AutomationTrigger;
  }
}

function CreateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { refs } = useCrmRefs();
  const [name, setName] = useState('');
  const [type, setType] = useState<AutomationTriggerType>('tag_added');
  const [tagId, setTagId] = useState('');
  const [saving, setSaving] = useState(false);
  const needsTag = type === 'tag_added' || type === 'tag_removed';
  const trigger = defaultTrigger(type, tagId ? Number(tagId) : undefined);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!trigger) return;
    setSaving(true);
    try {
      const a = await crmApi.createAutomation({ name: name.trim(), trigger, actions: [], enabled: false });
      onClose();
      navigate(`/automations/${a.id}`);
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
      title="Nouvelle automatisation"
      description="Choisissez le déclencheur : vous ajouterez les conditions et les actions ensuite. L’automatisation est créée désactivée."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="new-automation" loading={saving} disabled={!name.trim() || !trigger}>
            Créer
          </Button>
        </>
      }
    >
      <form id="new-automation" onSubmit={submit} className="space-y-4">
        <Field label="Nom">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Accueil des nouveaux clients" autoFocus maxLength={120} />
        </Field>
        <Field label="Déclencheur">
          <Select value={type} onChange={(e) => setType(e.target.value as AutomationTriggerType)}>
            {(Object.keys(AUTOMATION_TRIGGER_LABELS) as AutomationTriggerType[]).map((t) => (
              <option key={t} value={t}>
                {AUTOMATION_TRIGGER_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
        {needsTag && (
          <Field label="Tag" hint={refs.loaded && !refs.tags.length ? 'Créez d’abord un tag dans Contacts → Tags.' : undefined}>
            <Select value={tagId} onChange={(e) => setTagId(e.target.value)}>
              <option value="">Choisir un tag…</option>
              {refs.tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Modal>
  );
}

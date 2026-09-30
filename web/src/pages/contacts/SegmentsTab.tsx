// Contacts → « Segments »: saved multi-criteria filters, live counter, link to the filtered contact list.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Filter, Pencil, Plus, Trash, Users } from 'lucide-react';
import { emptyFilter, type Segment, type SegmentFilter } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import { useCrmRefs, type CrmRefs } from '../../lib/crm-refs';
import { useDebounced, useLoad } from '../../lib/hooks';
import { fmtDate, fmtNumber } from '../../lib/format';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { countConditions, FilterBuilder, isFilterComplete } from '../../components/FilterBuilder';

export function SegmentsTab() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload } = useLoad(() => crmApi.segments(), []);
  const { refs } = useCrmRefs();
  const [editing, setEditing] = useState<Segment | 'new' | null>(null);

  const remove = async (s: Segment) => {
    const ok = await confirm({ title: `Supprimer le segment « ${s.name} » ?`, message: 'Les contacts ne sont pas supprimés.', confirmLabel: 'Supprimer' });
    if (!ok) return;
    try {
      await crmApi.deleteSegment(s.id);
      reload();
      toast.success('Segment supprimé');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">Un segment regroupe les contacts qui remplissent des conditions (tags, champs, activité…). Il est recalculé à chaque utilisation.</p>
        <Button icon={Plus} onClick={() => setEditing('new')}>
          Nouveau segment
        </Button>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <Card className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </Card>
      ) : data.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="Aucun segment"
          description="Créez un segment pour cibler une newsletter, filtrer vos contacts ou appliquer une action groupée."
          action={
            <Button icon={Plus} onClick={() => setEditing('new')}>
              Créer un segment
            </Button>
          }
        />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {data.map((s) => (
              <li key={s.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Filter size={15} />
                </span>
                <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/contacts?segment=${s.id}`)}>
                  <span className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700">{s.name}</span>
                  <span className="block text-xs text-slate-500">
                    {countConditions(s.filter)} condition{countConditions(s.filter) > 1 ? 's' : ''} · modifié le {fmtDate(s.updated_at)}
                  </span>
                </button>
                <Badge tone="slate">
                  <Users size={12} /> {fmtNumber(s.contacts_count ?? 0)}
                </Badge>
                <button className="rounded-lg p-1.5 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-700" onClick={() => setEditing(s)} title="Modifier">
                  <Pencil size={15} />
                </button>
                <button className="rounded-lg p-1.5 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600" onClick={() => remove(s)} title="Supprimer">
                  <Trash size={15} />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <SegmentModal
        segment={editing}
        refs={refs}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </>
  );
}

/** Live number of contacts matching a filter (debounced). */
export function useFilterCount(filter: SegmentFilter, enabled = true) {
  const debounced = useDebounced(JSON.stringify(filter), 400);
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const f = JSON.parse(debounced) as SegmentFilter;
    if (!isFilterComplete(f)) {
      setCount(null);
      return;
    }
    let alive = true;
    crmApi
      .previewSegment(f)
      .then((r) => alive && setCount(r.count))
      .catch(() => alive && setCount(null));
    return () => {
      alive = false;
    };
  }, [debounced, enabled]);
  return count;
}

export function SegmentModal({
  segment,
  refs,
  onClose,
  onSaved,
  initialFilter,
}: {
  segment: Segment | 'new' | null;
  refs: CrmRefs;
  onClose: () => void;
  onSaved: (s: Segment) => void;
  initialFilter?: SegmentFilter;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [filter, setFilter] = useState<SegmentFilter>(emptyFilter());
  const [saving, setSaving] = useState(false);
  const open = segment !== null;
  useEffect(() => {
    if (segment === 'new') {
      setName('');
      setFilter(initialFilter ?? emptyFilter());
    } else if (segment) {
      setName(segment.name);
      setFilter(segment.filter);
    }
  }, [segment]); // eslint-disable-line react-hooks/exhaustive-deps
  const count = useFilterCount(filter, open);
  const complete = isFilterComplete(filter);

  const save = async () => {
    setSaving(true);
    try {
      const s = segment === 'new' || !segment ? await crmApi.createSegment({ name: name.trim(), filter }) : await crmApi.updateSegment(segment.id, { name: name.trim(), filter });
      toast.success(segment === 'new' ? 'Segment créé' : 'Segment mis à jour');
      onSaved(s);
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
      size="xl"
      title={segment === 'new' ? 'Nouveau segment' : 'Modifier le segment'}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <span className="text-sm text-slate-500">
            {complete ? (count === null ? 'Calcul…' : <><strong className="text-slate-900">{fmtNumber(count)}</strong> contact{count > 1 ? 's' : ''} correspondant{count > 1 ? 's' : ''}</>) : 'Complétez les conditions'}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Annuler
            </Button>
            <Button onClick={save} loading={saving} disabled={!name.trim() || !complete}>
              Enregistrer
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <Field label="Nom du segment">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Clients actifs" maxLength={120} autoFocus />
        </Field>
        <FilterBuilder value={filter} onChange={setFilter} refs={refs} />
      </div>
    </Modal>
  );
}

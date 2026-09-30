// Campaign detail: email conditions and the paginated subscribers list.
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Filter, Search, UserMinus, Users } from 'lucide-react';
import type { CampaignCondition, CampaignConditionType, CampaignSubscriber, SubscriptionStatus, Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { useDebounced, useLoad } from '../../lib/hooks';
import { contactName, fmtDate, fmtTimeOrDate } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Pagination, Select, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

const TYPE_LABELS: Record<CampaignConditionType, string> = {
  has_tag: 'a le tag',
  not_has_tag: 'n’a pas le tag',
  opened_previous: 'a ouvert l’email précédent',
  clicked_previous: 'a cliqué dans l’email précédent',
  not_opened_previous: 'n’a pas ouvert l’email précédent',
};
const needsTag = (t: CampaignConditionType) => t === 'has_tag' || t === 'not_has_tag';

/** "Si le contact a le tag « client » → sinon ignorer cet email" */
export function conditionLabel(c: CampaignCondition, tags: Tag[]) {
  const tag = needsTag(c.type) ? ` « ${tags.find((t) => t.id === c.tag_id)?.name ?? `#${c.tag_id}`} »` : '';
  return `Si le contact ${TYPE_LABELS[c.type]}${tag} → sinon ${c.action === 'stop' ? 'arrêter la séquence' : 'ignorer cet email'}`;
}

export function ConditionModal({
  open,
  onClose,
  value,
  tags,
  isFirst,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  value: CampaignCondition | null | undefined;
  tags: Tag[];
  isFirst: boolean;
  onSave: (c: CampaignCondition | null) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [type, setType] = useState<CampaignConditionType>('has_tag');
  const [tagId, setTagId] = useState('');
  const [action, setAction] = useState<'skip' | 'stop'>('skip');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnabled(!!value);
    setType(value?.type ?? 'has_tag');
    setTagId(value?.tag_id ? String(value.tag_id) : '');
    setAction(value?.action ?? 'skip');
  }, [open, value]);

  const valid = !enabled || !needsTag(type) || !!tagId;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(enabled ? { type, action, ...(needsTag(type) ? { tag_id: Number(tagId) } : {}) } : null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Condition d’envoi"
      description="Évaluée au moment où l’email doit partir, pour chaque contact."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="condition" loading={busy} disabled={!valid}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="condition" onSubmit={submit} className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600" />
          Envoyer cet email seulement si une condition est remplie
        </label>
        {enabled && (
          <>
            <Field label="Le contact…">
              <Select value={type} onChange={(e) => setType(e.target.value as CampaignConditionType)}>
                {(Object.keys(TYPE_LABELS) as CampaignConditionType[]).map((t) => (
                  <option key={t} value={t} disabled={isFirst && !needsTag(t)}>
                    {TYPE_LABELS[t]}
                    {isFirst && !needsTag(t) ? ' (pas pour le 1er email)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {needsTag(type) && (
              <Field label="Tag">
                <Select required value={tagId} onChange={(e) => setTagId(e.target.value)}>
                  <option value="">Choisir un tag…</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Sinon">
              <Select value={action} onChange={(e) => setAction(e.target.value as 'skip' | 'stop')}>
                <option value="skip">Ignorer cet email et passer au suivant</option>
                <option value="stop">Arrêter la séquence pour ce contact</option>
              </Select>
            </Field>
            {!needsTag(type) && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                « L’email précédent » = le dernier email de cette campagne réellement envoyé au contact. Donnez un délai à cet email (1 jour ou plus) pour laisser le
                temps de l’ouvrir.
              </p>
            )}
          </>
        )}
      </form>
    </Modal>
  );
}

const STATUS: Record<SubscriptionStatus, { label: string; tone: 'green' | 'slate' | 'amber' | 'red' | 'blue' }> = {
  active: { label: 'En cours', tone: 'blue' },
  completed: { label: 'Terminée', tone: 'green' },
  stopped: { label: 'Arrêtée', tone: 'amber' },
  unsubscribed: { label: 'Désinscrit', tone: 'red' },
};
const LIMIT = 20;

export function SubscribersCard({ campaignId, version, onChange }: { campaignId: number; version: number; onChange: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<SubscriptionStatus | ''>('');
  const [search, setSearch] = useState('');
  const dq = useDebounced(search.trim(), 300);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status, dq]);
  const { data, loading, reload } = useLoad(() => api.campaignSubscribers(campaignId, { page, limit: LIMIT, status, search: dq }), [campaignId, page, status, dq, version]);

  const remove = async (s: CampaignSubscriber) => {
    const ok = await confirm({
      title: `Désinscrire ${contactName(s)} de la campagne ?`,
      message: 'Les emails restants de la séquence ne lui seront pas envoyés. Le contact reste abonné à vos newsletters.',
      confirmLabel: 'Désinscrire de la campagne',
    });
    if (!ok) return;
    try {
      await api.unsubscribeFromCampaign(campaignId, s.contact_id);
      toast.success('Contact désinscrit de la campagne');
      reload();
      onChange();
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Card padded={false} className="mt-6">
      <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-3 md:flex-row md:items-center md:justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
          <Users size={16} className="text-sky-500" /> Inscrits {data ? <span className="text-sm font-normal text-slate-500">({data.total})</span> : null}
        </h2>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher…" className="sm:w-52" />
          <Select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus | '')} className="sm:w-44">
            <option value="">Tous les statuts</option>
            {(Object.keys(STATUS) as SubscriptionStatus[]).map((k) => (
              <option key={k} value={k}>
                {STATUS[k].label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {loading && !data ? (
        <div className="space-y-2 p-5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      ) : !data?.items.length ? (
        <EmptyState icon={status || dq ? Filter : Users} title={status || dq ? 'Aucun inscrit ne correspond' : 'Aucun inscrit'} className="border-0 shadow-none" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                <th className="px-5 py-2.5">Contact</th>
                <th className="px-3 py-2.5">Statut</th>
                <th className="px-3 py-2.5">Progression</th>
                <th className="px-3 py-2.5">Prochain email</th>
                <th className="px-3 py-2.5">Inscrit le</th>
                <th className="px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((s) => {
                const st = STATUS[s.status];
                const done = s.sent + s.skipped;
                return (
                  <tr key={s.contact_id} className="hover:bg-slate-50">
                    <td className="px-5 py-2.5">
                      <Link to={`/contacts/${s.contact_id}`} className="block truncate font-medium text-slate-900 hover:text-brand-700">
                        {contactName(s)}
                      </Link>
                      {contactName(s) !== s.email && <span className="block truncate text-xs text-slate-500">{s.email}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span title={s.stopped_reason ?? undefined}>
                        <Badge tone={st.tone}>{st.label}</Badge>
                      </span>
                      {s.stopped_reason && <span className="mt-0.5 block max-w-[220px] truncate text-[11px] text-slate-500">{s.stopped_reason}</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200">
                          <div className="h-full rounded-full bg-brand-500" style={{ width: `${s.total ? (done / s.total) * 100 : 0}%` }} />
                        </div>
                        <span className="text-xs whitespace-nowrap text-slate-500 tabular-nums">
                          {s.sent}/{s.total} envoyé{s.sent > 1 ? 's' : ''}
                          {s.skipped ? ` · ${s.skipped} ignoré${s.skipped > 1 ? 's' : ''}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-500">{s.next_send_at ? fmtTimeOrDate(s.next_send_at) : '—'}</td>
                    <td className="px-3 py-2.5 text-xs whitespace-nowrap text-slate-500">{fmtDate(s.enrolled_at)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {(s.status === 'active' || s.status === 'completed') && (
                        <Button size="xs" variant="ghost" icon={UserMinus} className="text-slate-500 hover:text-rose-600" onClick={() => remove(s)}>
                          Désinscrire
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > LIMIT && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
    </Card>
  );
}

import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Activity, CalendarClock, Mail, Megaphone, Plus, Send, Split, Tag as TagIcon, Trash, Users, Workflow } from 'lucide-react';
import type { Broadcast, Campaign, Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { useLoad, usePolling } from '../../lib/hooks';
import { fmtDate, fmtDateTime, fmtNumber, fmtPercent, fmtWeekdayDateTime, ratio } from '../../lib/format';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, PageHeader, Select, Skeleton, Tabs } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { TrackingTab } from './TrackingTab';
import { AiGenerateButton } from '../ai/AiGenerate';
import { countsOf, inProgress, LiveDot, StackedProgress, totalOf } from './queue';

type TabId = 'broadcasts' | 'campaigns' | 'outbox';

export function EmailsPage() {
  const [params, setParams] = useSearchParams();
  const t = params.get('tab');
  // "sends" is accepted as an alias of the tracking tab (stable key: "outbox")
  const tab: TabId = t === 'campaigns' ? t : t === 'outbox' || t === 'sends' ? 'outbox' : 'broadcasts';

  return (
    <>
      <PageHeader title="Emails" description="Newsletters ponctuelles, campagnes automatiques et suivi des envois." />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        tabs={[
          { id: 'broadcasts', label: 'Newsletters', icon: Megaphone },
          { id: 'campaigns', label: 'Campagnes', icon: Workflow },
          { id: 'outbox', label: 'Suivi des envois', icon: Activity },
        ]}
      />
      {tab === 'broadcasts' && <BroadcastsTab />}
      {tab === 'campaigns' && <CampaignsTab />}
      {tab === 'outbox' && <TrackingTab />}
    </>
  );
}

/* ---------------- broadcasts ---------------- */

function BroadcastsTab() {
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const { data, error, loading, reload } = useLoad(() => api.broadcasts(), []);
  const [open, setOpen] = useState(params.get('new') === '1');
  const [subject, setSubject] = useState('');
  const [saving, setSaving] = useState(false);

  const close = () => {
    setOpen(false);
    if (params.get('new')) {
      params.delete('new');
      setParams(params, { replace: true });
    }
  };

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const b = await api.createBroadcast(subject.trim());
      navigate(`/emails/broadcasts/${b.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (b: Broadcast) => {
    const ok = await confirm({
      title: `Supprimer « ${b.subject} » ?`,
      message: b.status === 'scheduled' ? 'Cette newsletter programmée ne partira pas et sera définitivement supprimée.' : 'Cette newsletter sera définitivement supprimée.',
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await api.deleteBroadcast(b.id);
      toast.success('Newsletter supprimée');
      reload();
    } catch (err) {
      toast.error(err);
    }
  };

  // scheduled first (next one on top), then the most recent
  const sorted = useMemo(
    () =>
      [...(data ?? [])].sort(
        (a, b) =>
          Number(b.status === 'scheduled') - Number(a.status === 'scheduled') ||
          (a.status === 'scheduled' ? (a.scheduled_at ?? '').localeCompare(b.scheduled_at ?? '') : 0) ||
          b.created_at.localeCompare(a.created_at),
      ),
    [data],
  );
  // follow newsletters being sent live
  usePolling(reload, 3000, sorted.some((b) => b.status === 'sent' && inProgress(b.stats)));

  return (
    <>
      <div className="mb-4 flex justify-end gap-2">
        <AiGenerateButton kind="newsletter" />
        <Button
          icon={Plus}
          onClick={() => {
            setSubject('');
            setOpen(true);
          }}
        >
          Nouvelle newsletter
        </Button>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <ListSkeleton />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="Aucune newsletter"
          description="Rédigez un email avec l’éditeur visuel et envoyez-le à tous vos contacts ou à un segment."
          action={
            <Button icon={Plus} onClick={() => setOpen(true)}>
              Nouvelle newsletter
            </Button>
          }
        />
      ) : (
        <Card padded={false} className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {sorted.map((b) => {
              const s = b.stats;
              const sent = s?.sent ?? 0;
              const c = countsOf(s);
              const live = b.status === 'sent' && inProgress(s);
              return (
                <li key={b.id} className="group flex cursor-pointer flex-col gap-3 px-5 py-4 hover:bg-slate-50 sm:flex-row sm:items-center" onClick={() => navigate(`/emails/broadcasts/${b.id}`)}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      className={cx(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl',
                        b.status === 'sent' ? 'bg-emerald-50 text-emerald-600' : b.status === 'scheduled' ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-500',
                      )}
                    >
                      {b.status === 'sent' ? <Send size={18} /> : b.status === 'scheduled' ? <CalendarClock size={18} /> : <Mail size={18} />}
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate font-medium text-slate-900">
                        <span className="truncate">{b.subject || 'Sans objet'}</span>
                        {b.ab_test && (
                          <span title="Test A/B de l’objet" className="shrink-0 text-violet-500">
                            <Split size={14} />
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">
                        {b.status === 'sent'
                          ? `Envoyée le ${fmtDateTime(b.sent_at)}`
                          : b.status === 'scheduled'
                            ? `Envoi programmé le ${fmtWeekdayDateTime(b.scheduled_at)}`
                            : `Créée le ${fmtDate(b.created_at)}`}
                      </p>
                    </div>
                  </div>
                  {b.status === 'sent' ? (
                    <div className="flex items-center gap-5 text-sm">
                      {live && (
                        <div className="hidden w-36 md:block" title={`${fmtNumber(c.sent + c.failed)} / ${fmtNumber(totalOf(c))} traités`}>
                          <StackedProgress c={c} size="sm" />
                          <p className="mt-1 text-[11px] text-slate-500 tabular-nums">
                            {fmtNumber(c.pending + c.sending)} restant{c.pending + c.sending > 1 ? 's' : ''}
                            {c.failed > 0 && <span className="text-rose-600"> · {fmtNumber(c.failed)} échec{c.failed > 1 ? 's' : ''}</span>}
                          </p>
                        </div>
                      )}
                      <MiniStat label="Envoyés" value={fmtNumber(sent)} />
                      <MiniStat label="Ouverture" value={fmtPercent(ratio(s?.opened, sent))} />
                      <MiniStat label="Clics" value={fmtPercent(ratio(s?.clicked, sent))} />
                      {!live && c.failed > 0 && <Badge tone="red">{fmtNumber(c.failed)} échec{c.failed > 1 ? 's' : ''}</Badge>}
                    </div>
                  ) : null}
                  <div className="flex items-center gap-2">
                    {b.status === 'sent' ? (
                      live ? (
                        <Badge tone="blue">
                          <LiveDot tone="sky" className="scale-75" /> En cours d’envoi
                        </Badge>
                      ) : (
                        <Badge tone="green" dot>
                          Envoyée
                        </Badge>
                      )
                    ) : b.status === 'scheduled' ? (
                      <Badge tone="violet">
                        <CalendarClock size={12} /> Programmée · {fmtWeekdayDateTime(b.scheduled_at)}
                      </Badge>
                    ) : (
                      <Badge tone="slate" dot>
                        Brouillon
                      </Badge>
                    )}
                    {b.status !== 'sent' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          remove(b);
                        }}
                        className="rounded-lg p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600"
                        title="Supprimer"
                      >
                        <Trash size={15} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Modal
        open={open}
        onClose={close}
        title="Nouvelle newsletter"
        footer={
          <>
            <Button variant="secondary" onClick={close}>
              Annuler
            </Button>
            <Button type="submit" form="new-broadcast" loading={saving} disabled={!subject.trim()}>
              Créer et éditer
            </Button>
          </>
        }
      >
        <form id="new-broadcast" onSubmit={create}>
          <Field label="Objet de l’email" hint="Vous pourrez le modifier ensuite.">
            <Input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="ex. Notre nouveauté du mois 🎉" />
          </Field>
        </form>
      </Modal>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-right">
      <p className="text-[11px] text-slate-500">{label}</p>
      <p className="font-semibold text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}

function ListSkeleton() {
  return (
    <Card padded={false}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-slate-100 px-5 py-4 last:border-0">
          <Skeleton className="h-10 w-10 rounded-xl" />
          <div className="flex-1">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </Card>
  );
}

/* ---------------- campaigns ---------------- */

function CampaignsTab() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(() => Promise.all([api.campaigns(), api.tags()]), []);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [tagId, setTagId] = useState('');
  const [saving, setSaving] = useState(false);

  const campaigns = data?.[0];
  const tags = data?.[1] ?? [];
  const tagName = (id: number | null) => (id ? tags.find((t) => t.id === id)?.name ?? `#${id}` : null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const c = await api.createCampaign({ name: name.trim(), trigger_tag_id: tagId ? Number(tagId) : null });
      navigate(`/emails/campaigns/${c.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const openCreate = () => {
    setName('');
    setTagId('');
    setOpen(true);
  };

  return (
    <>
      <div className="mb-4 flex justify-end gap-2">
        <AiGenerateButton kind="campaign" />
        <Button icon={Plus} onClick={openCreate}>
          Nouvelle campagne
        </Button>
      </div>
      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <ListSkeleton />
      ) : !campaigns?.length ? (
        <EmptyState
          icon={Workflow}
          title="Aucune campagne"
          description="Une campagne envoie automatiquement une séquence d’emails (J+0, J+2, J+5…) aux contacts qui reçoivent un tag."
          action={
            <Button icon={Plus} onClick={openCreate}>
              Nouvelle campagne
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {campaigns.map((c) => (
            <CampaignCard key={c.id} c={c} trigger={tagName(c.trigger_tag_id)} onClick={() => navigate(`/emails/campaigns/${c.id}`)} />
          ))}
        </div>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nouvelle campagne"
        description="Les contacts qui reçoivent le tag déclencheur sont inscrits automatiquement."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" form="new-campaign" loading={saving} disabled={!name.trim()}>
              Créer la campagne
            </Button>
          </>
        }
      >
        <form id="new-campaign" onSubmit={create} className="space-y-4">
          <Field label="Nom">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. Séquence de bienvenue" />
          </Field>
          <TriggerSelect tags={tags} value={tagId} onChange={setTagId} />
        </form>
      </Modal>
    </>
  );
}

export function TriggerSelect({ tags, value, onChange }: { tags: Tag[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Tag déclencheur" hint="Facultatif — vous pouvez aussi inscrire des contacts via un formulaire de tunnel.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Aucun (inscription manuelle ou via formulaire)</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function CampaignCard({ c, trigger, onClick }: { c: Campaign; trigger: string | null; onClick: () => void }) {
  const emails = c.emails ?? [];
  const totalDays = emails.reduce((a, e) => a + (e.delay_days ?? 0), 0);
  return (
    <button onClick={onClick} className="group block text-left">
      <Card className="h-full transition-all group-hover:-translate-y-0.5 group-hover:border-brand-200 group-hover:shadow-pop">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <Workflow size={18} />
          </span>
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900 group-hover:text-brand-700">{c.name}</h3>
            <p className="mt-0.5 flex items-center gap-1 text-xs text-slate-500">
              <TagIcon size={12} /> {trigger ? `Déclenchée par « ${trigger} »` : 'Sans tag déclencheur'}
            </p>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-1">
          {emails.slice(0, 8).map((e) => (
            <span key={e.id} className="h-1.5 flex-1 rounded-full bg-brand-400" title={e.subject} />
          ))}
          {emails.length === 0 && <span className="h-1.5 flex-1 rounded-full bg-slate-200" />}
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Mail size={13} /> {emails.length} email{emails.length > 1 ? 's' : ''} · {totalDays} j
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Users size={13} /> {fmtNumber(c.subscribers ?? 0)} inscrit{(c.subscribers ?? 0) > 1 ? 's' : ''}
          </span>
        </div>
      </Card>
    </button>
  );
}

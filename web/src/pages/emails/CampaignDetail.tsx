import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  CircleStop,
  Clock,
  GitBranch,
  Eye,
  Mail,
  MailOpen,
  MousePointerClick,
  Pencil,
  Plus,
  Search,
  Send,
  Trash,
  UserPlus,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import type { CampaignCondition, CampaignEmail, Contact, PageContent, Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { useBeforeUnload, useDebounced, useLoad } from '../../lib/hooks';
import { contactName, fmtNumber, fmtPercent, ratio } from '../../lib/format';
import { Builder, type BuilderHandle, type BuilderPanel } from '../../builder/Builder';
import { PreviewMenu, SaveButton, SaveStatus } from '../../builder/bar';
import { Prop, inputCls } from '../../builder/controls';
import { PreheaderField } from '../../builder/Inspector';
import { SubjectInput } from './BroadcastEditor';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Field, Input, PageLoader, Select, Spinner } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useUnsavedGuard } from '../../components/useUnsavedGuard';
import { EmailPreview } from './EmailPreview';
import { ConditionModal, conditionLabel, SubscribersCard } from './CampaignExtras';

export function CampaignDetailPage() {
  const { id } = useParams();
  const cid = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data, setData, error, loading, reload } = useLoad(async () => {
    const [campaign, tags] = await Promise.all([api.campaign(cid), api.tags().catch(() => [] as Tag[])]);
    return { campaign, tags };
  }, [cid]);
  const [name, setName] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<CampaignEmail | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [conditionFor, setConditionFor] = useState<CampaignEmail | null>(null);
  const [subsVersion, setSubsVersion] = useState(0);

  useEffect(() => {
    if (data) setName(data.campaign.name);
  }, [data?.campaign.name]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return null;

  const { campaign, tags } = data;
  const emails = [...(campaign.emails ?? [])].sort((a, b) => a.position - b.position);
  const setEmails = (next: CampaignEmail[]) => setData({ ...data, campaign: { ...campaign, emails: next } });

  const saveName = async () => {
    const n = name.trim();
    if (!n || n === campaign.name) {
      setName(campaign.name);
      return;
    }
    try {
      const c = await api.updateCampaign(campaign.id, { name: n });
      setData({ ...data, campaign: { ...campaign, name: c.name } });
      toast.success('Campagne renommée');
    } catch (e) {
      toast.error(e);
      setName(campaign.name);
    }
  };

  const changeTrigger = async (v: string) => {
    try {
      const c = await api.updateCampaign(campaign.id, { trigger_tag_id: v ? Number(v) : null });
      setData({ ...data, campaign: { ...campaign, trigger_tag_id: c.trigger_tag_id } });
      toast.success(v ? 'Tag déclencheur mis à jour' : 'Tag déclencheur retiré');
    } catch (e) {
      toast.error(e);
    }
  };

  const changeStopTag = async (v: string) => {
    try {
      const c = await api.updateCampaign(campaign.id, { stop_tag_id: v ? Number(v) : null });
      setData({ ...data, campaign: { ...campaign, stop_tag_id: c.stop_tag_id } });
      toast.success(v ? 'Les contacts qui reçoivent ce tag quitteront la séquence' : 'Tag d’arrêt retiré');
    } catch (e) {
      toast.error(e);
    }
  };

  const move = async (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= emails.length) return;
    const ids = emails.map((e) => e.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      const c = await api.reorderCampaignEmails(campaign.id, ids);
      setEmails((c.emails ?? []).map((e) => ({ ...e, stats: emails.find((x) => x.id === e.id)?.stats ?? e.stats })));
      toast.success('Ordre mis à jour : les envois programmés ont été recalculés');
    } catch (e) {
      toast.error(e);
    }
  };

  const saveCondition = async (e: CampaignEmail, condition: CampaignCondition | null) => {
    try {
      const u = await api.updateCampaignEmail(e.id, { condition });
      setEmails(emails.map((x) => (x.id === e.id ? { ...x, condition: u.condition } : x)));
      toast.success(condition ? 'Condition enregistrée' : 'Condition retirée');
    } catch (err) {
      toast.error(err);
      throw err;
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Supprimer « ${campaign.name} » ?`,
      message: 'Les emails de la campagne et les envois programmés seront supprimés.',
      confirmLabel: 'Supprimer la campagne',
    });
    if (!ok) return;
    try {
      await api.deleteCampaign(campaign.id);
      toast.success('Campagne supprimée');
      navigate('/emails?tab=campaigns');
    } catch (e) {
      toast.error(e);
    }
  };

  const removeEmail = async (e: CampaignEmail) => {
    const ok = await confirm({ title: `Supprimer l’email « ${e.subject} » ?`, confirmLabel: 'Supprimer' });
    if (!ok) return;
    try {
      await api.deleteCampaignEmail(e.id);
      setEmails(emails.filter((x) => x.id !== e.id));
      toast.success('Email supprimé');
    } catch (err) {
      toast.error(err);
    }
  };

  let cumulative = 0;

  return (
    <>
      <Link to="/emails?tab=campaigns" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft size={16} /> Campagnes
      </Link>

      <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
            <Workflow size={22} />
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            className="-ml-2 min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-2xl font-bold tracking-tight text-slate-900 hover:border-slate-200 focus:border-brand-500 focus:bg-white focus:ring-4 focus:ring-brand-500/15 focus:outline-none"
            title="Cliquez pour renommer"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={UserPlus} onClick={() => setEnrollOpen(true)}>
            Inscrire un contact
          </Button>
          <Button variant="secondary" icon={Trash} className="text-rose-600 hover:text-rose-700" onClick={remove}>
            Supprimer
          </Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-6">
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <Zap size={16} className="text-amber-500" />
              <h3 className="text-sm font-semibold text-slate-900">Déclencheur</h3>
            </div>
            <p className="mb-3 text-sm text-slate-500">Quand un contact reçoit ce tag, il est inscrit à la campagne et reçoit la séquence.</p>
            <Select value={campaign.trigger_tag_id ?? ''} onChange={(e) => changeTrigger(e.target.value)}>
              <option value="">Aucun tag déclencheur</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            <p className="mt-3 text-xs text-slate-400">Astuce : un formulaire de tunnel peut aussi inscrire directement à cette campagne.</p>
          </Card>
          <Card>
            <div className="mb-3 flex items-center gap-2">
              <CircleStop size={16} className="text-rose-500" />
              <h3 className="text-sm font-semibold text-slate-900">Arrêter la séquence</h3>
            </div>
            <p className="mb-3 text-sm text-slate-500">Quand un contact reçoit ce tag (ex. « client » après un achat), il quitte la séquence.</p>
            <Select value={campaign.stop_tag_id ?? ''} onChange={(e) => changeStopTag(e.target.value)}>
              <option value="">Aucun tag d’arrêt</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Card>
          <Card>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="flex items-center justify-center gap-1 text-xs text-slate-500">
                  <Users size={12} /> Inscrits
                </p>
                <p className="mt-1 text-xl font-bold text-slate-900">{fmtNumber(campaign.subscribers ?? 0)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="flex items-center justify-center gap-1 text-xs text-slate-500">
                  <Mail size={12} /> Emails
                </p>
                <p className="mt-1 text-xl font-bold text-slate-900">{emails.length}</p>
              </div>
            </div>
          </Card>
        </div>

        <div className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Séquence d’emails</h2>
            <Button icon={Plus} onClick={() => setAddOpen(true)}>
              Ajouter un email
            </Button>
          </div>
          {emails.length === 0 ? (
            <EmptyState
              icon={Mail}
              title="Aucun email dans la séquence"
              description="Ajoutez le premier email : il peut partir dès l’inscription (délai 0) ou quelques jours plus tard."
              action={
                <Button icon={Plus} onClick={() => setAddOpen(true)}>
                  Ajouter un email
                </Button>
              }
            />
          ) : (
            <ol className="relative">
              <li className="relative flex gap-4 pb-5">
                <span className="absolute top-10 bottom-0 left-[19px] w-0.5 bg-slate-200" />
                <span className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-600 ring-4 ring-slate-50">
                  <Zap size={18} />
                </span>
                <div className="pt-2.5 text-sm text-slate-600">
                  Inscription du contact
                  {campaign.trigger_tag_id && <> (tag « {tags.find((t) => t.id === campaign.trigger_tag_id)?.name ?? campaign.trigger_tag_id} »)</>}
                </div>
              </li>
              {emails.map((e, i) => {
                cumulative += e.delay_days;
                const st = e.stats;
                const sent = st?.sent ?? 0;
                return (
                  <li key={e.id} className="relative flex gap-4 pb-5 last:pb-0">
                    {i < emails.length - 1 && <span className="absolute top-10 bottom-0 left-[19px] w-0.5 bg-slate-200" />}
                    <span className="relative z-10 flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-full bg-brand-600 text-white ring-4 ring-slate-50">
                      <span className="text-[9px] leading-none font-medium uppercase opacity-80">Jour</span>
                      <span className="text-sm leading-none font-bold">{cumulative}</span>
                    </span>
                    <Card className="group min-w-0 flex-1 transition-shadow hover:shadow-pop" padded={false}>
                      <div className="flex flex-col gap-3 p-4 xl:flex-row xl:items-center">
                        <div className="min-w-0 flex-1">
                          <p className="flex items-center gap-1.5 text-xs text-slate-500">
                            <Clock size={12} />
                            {e.delay_days === 0
                              ? i === 0
                                ? 'Immédiatement après l’inscription'
                                : 'Le même jour que l’email précédent'
                              : `${e.delay_days} jour${e.delay_days > 1 ? 's' : ''} après ${i === 0 ? 'l’inscription' : 'l’email précédent'}`}
                          </p>
                          <p className="mt-1 truncate font-semibold text-slate-900">{e.subject}</p>
                          {e.condition && (
                            <p className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
                              <GitBranch size={12} className="shrink-0" /> <span className="truncate">{conditionLabel(e.condition, tags)}</span>
                            </p>
                          )}
                          <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                            <span className="inline-flex items-center gap-1">
                              <Send size={12} /> {fmtNumber(sent)} envoyé{sent > 1 ? 's' : ''}
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <MailOpen size={12} /> {fmtPercent(ratio(st?.opened, sent))} ouverture
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <MousePointerClick size={12} /> {fmtPercent(ratio(st?.clicked, sent))} clics
                            </span>
                            {(st?.pending ?? 0) > 0 && <Badge tone="amber">{st!.pending} programmé{st!.pending > 1 ? 's' : ''}</Badge>}
                            {(st?.skipped ?? 0) > 0 && <Badge tone="slate">{st!.skipped} ignoré{st!.skipped! > 1 ? 's' : ''}</Badge>}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <div className="flex flex-col">
                            <button disabled={i === 0} onClick={() => move(i, -1)} title="Monter" className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30">
                              <ArrowUp size={14} />
                            </button>
                            <button disabled={i === emails.length - 1} onClick={() => move(i, 1)} title="Descendre" className="rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30">
                              <ArrowDown size={14} />
                            </button>
                          </div>
                          <Button size="sm" variant="ghost" icon={GitBranch} className={e.condition ? 'text-violet-700' : 'text-slate-500'} onClick={() => setConditionFor(e)}>
                            Condition
                          </Button>
                          <Button size="sm" variant="secondary" icon={Pencil} onClick={() => setEditing(e)}>
                            Modifier
                          </Button>
                          <Button size="sm" variant="ghost" icon={Trash} className="text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => removeEmail(e)} aria-label="Supprimer" />
                        </div>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </div>

      <SubscribersCard campaignId={campaign.id} version={subsVersion} onChange={reload} />

      <ConditionModal
        open={!!conditionFor}
        onClose={() => setConditionFor(null)}
        value={conditionFor?.condition}
        tags={tags}
        isFirst={!!conditionFor && emails[0]?.id === conditionFor.id}
        onSave={(c) => saveCondition(conditionFor!, c)}
      />
      <AddEmailModal
        open={addOpen}
        campaignId={campaign.id}
        subscribers={campaign.subscribers ?? 0}
        isFirst={emails.length === 0}
        onClose={() => setAddOpen(false)}
        onCreated={(e) => {
          setEmails([...emails, e]);
          setAddOpen(false);
          setEditing(e);
          setSubsVersion((v) => v + 1);
        }}
      />
      <EnrollModal
        open={enrollOpen}
        campaignId={campaign.id}
        onClose={() => setEnrollOpen(false)}
        onEnrolled={() => {
          reload();
          setSubsVersion((v) => v + 1);
        }}
      />
      {editing && (
        <CampaignEmailEditor
          email={editing}
          campaignName={campaign.name}
          onClose={() => setEditing(null)}
          onSaved={(e) => setEmails(emails.map((x) => (x.id === e.id ? { ...x, ...e, stats: x.stats } : x)))}
        />
      )}
    </>
  );
}

function AddEmailModal({
  open,
  campaignId,
  subscribers,
  isFirst,
  onClose,
  onCreated,
}: {
  open: boolean;
  campaignId: number;
  subscribers: number;
  isFirst: boolean;
  onClose: () => void;
  onCreated: (e: CampaignEmail) => void;
}) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [delay, setDelay] = useState(0);
  const [applyExisting, setApplyExisting] = useState(true);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setSubject('');
      setDelay(isFirst ? 0 : 2);
      setApplyExisting(true);
    }
  }, [open, isFirst]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await api.createCampaignEmail(campaignId, { subject: subject.trim(), delay_days: delay, apply_to_existing: applyExisting });
      toast.success(
        created.backfilled
          ? `Email ajouté : programmé pour ${created.backfilled} inscrit${created.backfilled > 1 ? 's' : ''} existant${created.backfilled > 1 ? 's' : ''}`
          : 'Email ajouté à la séquence',
      );
      onCreated(created);
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
      title="Ajouter un email"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="add-campaign-email" loading={saving} disabled={!subject.trim()}>
            Ajouter et éditer
          </Button>
        </>
      }
    >
      <form id="add-campaign-email" onSubmit={submit} className="space-y-4">
        <Field label="Objet">
          <Input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="ex. Bienvenue {{first_name}} !" />
        </Field>
        <Field label="Délai" hint={isFirst ? 'Nombre de jours après l’inscription (0 = immédiatement).' : 'Nombre de jours après l’email précédent.'}>
          <div className="flex items-center gap-2">
            <Input type="number" min={0} max={365} value={delay} onChange={(e) => setDelay(Math.max(0, Number(e.target.value) || 0))} className="w-28" />
            <span className="text-sm text-slate-500">jour{delay > 1 ? 's' : ''}</span>
          </div>
        </Field>
        {subscribers > 0 ? (
          <div className="rounded-lg border border-slate-200 p-3">
            <label className="flex items-start gap-2.5 text-sm text-slate-700">
              <input type="checkbox" checked={applyExisting} onChange={(e) => setApplyExisting(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600" />
              <span>
                <span className="font-medium">Inscrits actuels ({subscribers}) : l’envoyer maintenant à ceux qui ont déjà dépassé ce point</span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Pour chaque inscrit, la date prévue = inscription + délais cumulés. Si elle est déjà passée, l’email part dans 10 minutes, le temps de le rédiger (case cochée), ou est ignoré
                  pour lui (case décochée). Les inscrits qui n’ont pas encore atteint ce point le recevront normalement. Jamais deux fois le même email.
                </span>
              </span>
            </label>
          </div>
        ) : (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">Vous pourrez ajouter une condition d’envoi après l’avoir créé.</p>
        )}
      </form>
    </Modal>
  );
}

function EnrollModal({ open, campaignId, onClose, onEnrolled }: { open: boolean; campaignId: number; onClose: () => void; onEnrolled: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 250);
  const [results, setResults] = useState<Contact[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setResults(null);
    api
      .contacts({ search: dq, limit: 8 })
      .then((r) => alive && setResults(r.items))
      .catch(() => alive && setResults([]));
    return () => {
      alive = false;
    };
  }, [dq, open]);

  useEffect(() => {
    if (open) setQ('');
  }, [open]);

  const enroll = async (c: Contact) => {
    setBusy(c.id);
    try {
      await api.enroll(campaignId, c.id);
      toast.success(`${contactName(c)} inscrit à la campagne`);
      onEnrolled();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Inscrire un contact" description="Le contact recevra toute la séquence à partir de maintenant.">
      <Input icon={Search} placeholder="Rechercher un contact…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-3 max-h-72 overflow-y-auto">
        {results === null ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : results.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-500">Aucun contact trouvé.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {results.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{contactName(c)}</p>
                  <p className="truncate text-xs text-slate-500">{c.email}</p>
                </div>
                {c.unsubscribed ? <Badge tone="red">Désinscrit</Badge> : null}
                {c.status === 'pending_confirmation' ? <Badge tone="amber">Non confirmé</Badge> : null}
                <Button size="sm" variant="secondary" loading={busy === c.id} onClick={() => enroll(c)}>
                  Inscrire
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function CampaignEmailEditor({ email, campaignName, onClose, onSaved }: { email: CampaignEmail; campaignName: string; onClose: () => void; onSaved: (e: CampaignEmail) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [subject, setSubject] = useState(email.subject);
  const [delay, setDelay] = useState(email.delay_days);
  const [content, setContent] = useState<PageContent>(email.content);
  const [saved, setSaved] = useState({ subject: email.subject, delay: email.delay_days, json: JSON.stringify(email.content) });
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [preview, setPreview] = useState(false);
  const builder = useRef<BuilderHandle>(null);

  const json = useMemo(() => JSON.stringify(content), [content]);
  const dirty = subject !== saved.subject || delay !== saved.delay || json !== saved.json;
  useBeforeUnload(dirty);
  useUnsavedGuard(dirty);

  const stateRef = useRef({ subject, delay, content });
  stateRef.current = { subject, delay, content };

  const save = useCallback(async () => {
    const s = stateRef.current;
    if (!s.subject.trim()) {
      toast.error('L’objet est obligatoire.');
      return false;
    }
    setSaving(true);
    try {
      const updated = await api.updateCampaignEmail(email.id, { subject: s.subject.trim(), delay_days: s.delay, content: s.content });
      setSaved({ subject: s.subject, delay: s.delay, json: JSON.stringify(s.content) });
      onSaved({ ...email, ...updated, subject: s.subject.trim(), delay_days: s.delay, content: s.content });
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [email, onSaved, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [save]);

  const close = async () => {
    if (dirty) {
      const ok = await confirm({ title: 'Fermer sans enregistrer ?', message: 'Vos modifications seront perdues.', confirmLabel: 'Fermer', cancelLabel: 'Continuer l’édition' });
      if (!ok) return;
    }
    onClose();
  };

  const panels: BuilderPanel[] = [
    {
      id: 'send',
      label: 'Paramètres d’envoi',
      icon: Clock,
      render: () => (
        <div className="scalo-scroll flex-1 space-y-5 overflow-y-auto border-t border-slate-100 px-4 py-4">
          <Prop label="Délai d’envoi" hint="Nombre de jours après l’email précédent (ou après l’inscription pour le premier email). 0 = immédiatement.">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={365}
                value={delay}
                onChange={(e) => setDelay(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
                className={cx(inputCls, 'w-24 tabular-nums')}
              />
              <span className="text-sm text-slate-500">jour{delay > 1 ? 's' : ''}</span>
            </div>
          </Prop>
          <PreheaderField value={content.settings?.preheader} />
        </div>
      ),
    },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[60] flex animate-fade-in flex-col bg-white">
      <Builder
        ref={builder}
        content={content}
        onChange={setContent}
        mode="email"
        title={subject}
        panels={panels}
        barStart={
          <>
            <button onClick={close} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" title="Fermer" aria-label="Fermer">
              <X size={17} />
            </button>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />
            <span className="hidden max-w-[160px] shrink-0 truncate text-sm text-slate-400 lg:inline" title={`Campagne : ${campaignName}`}>
              {campaignName}
            </span>
            <span className="hidden text-slate-300 lg:inline">/</span>
            <SubjectInput value={subject} onChange={setSubject} />
            <button
              type="button"
              onClick={() => builder.current?.openPanel('send')}
              className="hidden shrink-0 items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium whitespace-nowrap text-slate-600 hover:bg-slate-200/70 md:inline-flex"
              title="Délai d’envoi"
            >
              <Clock size={12} /> {delay === 0 ? 'Immédiat' : `J+${delay}`}
            </button>
          </>
        }
        barEnd={({ preview: inEditor, togglePreview }) => (
          <>
            <SaveStatus saving={saving} dirty={dirty} detail={justSaved ? 'Enregistré à l’instant' : undefined} />
            <PreviewMenu
              preview={inEditor}
              onToggle={togglePreview}
              items={[
                { label: inEditor ? 'Revenir à l’édition' : 'Aperçu dans l’éditeur', description: 'Ordinateur, tablette ou mobile', icon: Eye, onClick: togglePreview },
                { label: 'Aperçu avec un contact d’exemple', description: 'Variables remplacées, pied d’email inclus', icon: MailOpen, onClick: () => setPreview(true) },
              ]}
            />
            <SaveButton onClick={save} saving={saving} dirty={dirty} />
          </>
        )}
      />
      <EmailPreview open={preview} onClose={() => setPreview(false)} content={content} subject={subject} />
    </div>,
    document.body,
  );
}

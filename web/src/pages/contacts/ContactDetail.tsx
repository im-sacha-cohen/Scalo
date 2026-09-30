import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  BellOff,
  CalendarClock,
  Clock,
  Mail,
  MailOpen,
  MailX,
  MousePointerClick,
  Plus,
  Send,
  Tag as TagIcon,
  Trash,
  Upload,
  UserPlus,
  Workflow,
  X,
  Funnel,
  Tags,
  CircleDot,
  MailCheck,
  MailQuestion,
  ShieldAlert,
  LogOut,
  RefreshCw,
  ShoppingCart,
  type LucideIcon,
} from 'lucide-react';
import type { ContactEvent } from '@scalo/shared';
import { api, type ContactDetail } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { ContactFieldsCard } from './ContactFieldsCard';
import { ContactOrders } from '../sales/SalesWidgets';
import { AffiliateMentionCard } from '../affiliates/AffiliateMentionCard';
import { contactName, fmtDate, fmtDateTime, fmtRelative, initials } from '../../lib/format';
import { Avatar, Badge, Button, Card, CardHeader, cx, ErrorState, Field, Input, PageLoader, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function money(amount: number, currency: unknown) {
  const cur = typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : null;
  try {
    return cur ? amount.toLocaleString('fr-FR', { style: 'currency', currency: cur }) : amount.toLocaleString('fr-FR');
  } catch {
    return `${amount} ${cur ?? ''}`.trim();
  }
}

function describeEvent(e: ContactEvent): { icon: LucideIcon; tone: string; title: string; detail?: string } {
  const d = e.data ?? {};
  switch (e.type) {
    case 'created':
      return { icon: UserPlus, tone: 'bg-brand-100 text-brand-600', title: 'Contact créé' };
    case 'optin':
      return {
        icon: Funnel,
        tone: 'bg-emerald-100 text-emerald-600',
        title: 'Inscription via un tunnel',
        detail: [d.funnel && `Tunnel « ${str(d.funnel)} »`, d.step && `étape « ${str(d.step)} »`].filter(Boolean).join(', ') || undefined,
      };
    case 'tag_added':
      return { icon: TagIcon, tone: 'bg-violet-100 text-violet-600', title: `Tag « ${str(d.tag)} » ajouté` };
    case 'tag_removed':
      return { icon: Tags, tone: 'bg-slate-200 text-slate-600', title: `Tag « ${str(d.tag)} » retiré` };
    case 'campaign_enrolled':
      return { icon: Workflow, tone: 'bg-sky-100 text-sky-600', title: `Inscrit à la campagne « ${str(d.campaign)} »` };
    case 'email_sent':
      return { icon: Send, tone: 'bg-indigo-100 text-indigo-600', title: 'Email envoyé', detail: d.subject ? `« ${str(d.subject)} »` : undefined };
    case 'email_opened':
      return { icon: MailOpen, tone: 'bg-amber-100 text-amber-700', title: 'Email ouvert', detail: d.subject ? `« ${str(d.subject)} »` : undefined };
    case 'email_clicked':
      return { icon: MousePointerClick, tone: 'bg-orange-100 text-orange-600', title: 'Lien cliqué dans un email', detail: str(d.url) || undefined };
    case 'unsubscribed':
      return { icon: BellOff, tone: 'bg-rose-100 text-rose-600', title: 'Désinscription des emails' };
    case 'bounced':
      return {
        icon: MailX,
        tone: 'bg-rose-100 text-rose-600',
        title: 'Email rejeté (adresse invalide)',
        detail: [d.subject && `« ${str(d.subject)} »`, d.error && str(d.error)].filter(Boolean).join(' — ') || undefined,
      };
    case 'imported':
      return { icon: Upload, tone: 'bg-teal-100 text-teal-600', title: 'Importé depuis un fichier CSV' };
    case 'confirmation_sent':
      return { icon: MailQuestion, tone: 'bg-amber-100 text-amber-700', title: 'Email de confirmation envoyé (double opt-in)', detail: d.subject ? `« ${str(d.subject)} »` : undefined };
    case 'optin_confirmed':
      return {
        icon: MailCheck,
        tone: 'bg-emerald-100 text-emerald-600',
        title: 'Inscription confirmée (double opt-in)',
        detail: [d.funnel && `Tunnel « ${str(d.funnel)} »`, d.step && `étape « ${str(d.step)} »`].filter(Boolean).join(', ') || undefined,
      };
    case 'spam_complaint':
      return { icon: ShieldAlert, tone: 'bg-rose-100 text-rose-600', title: 'A signalé un email comme spam', detail: d.source ? `Signalé via ${str(d.source)}` : undefined };
    case 'campaign_left':
      return {
        icon: LogOut,
        tone: 'bg-slate-200 text-slate-600',
        title: `A quitté la campagne « ${str(d.campaign)} »`,
        detail: str(d.reason) || undefined,
      };
    case 'campaign_completed':
      return { icon: Workflow, tone: 'bg-emerald-100 text-emerald-600', title: `A terminé la campagne « ${str(d.campaign)} »` };
    // courses (members area)
    case 'course_access_granted':
      return { icon: UserPlus, tone: 'bg-indigo-100 text-indigo-600', title: `Accès donné à la formation « ${str(d.course)} »`, detail: d.via === 'manual' ? 'Inscription manuelle' : undefined };
    case 'lesson_completed':
      return { icon: Workflow, tone: 'bg-sky-100 text-sky-600', title: `Leçon terminée : ${str(d.lesson)}`, detail: d.course ? `Formation « ${str(d.course)} »` : undefined };
    case 'course_completed':
      return { icon: Workflow, tone: 'bg-emerald-100 text-emerald-700', title: `A terminé la formation « ${str(d.course)} »` };
    // affiliation
    case 'affiliate_joined':
      return { icon: UserPlus, tone: 'bg-violet-100 text-violet-600', title: 'Est devenu affilié', detail: d.code ? `Code « ${str(d.code)} »` : undefined };
    case 'affiliate_commission':
      return {
        icon: ShoppingCart,
        tone: 'bg-violet-100 text-violet-600',
        title: `Commission d’affiliation gagnée${typeof d.amount === 'number' ? ` : ${money(d.amount, d.currency)}` : ''}`,
        detail: [d.product && str(d.product), d.recurring ? 'paiement récurrent' : null].filter(Boolean).join(' · ') || undefined,
      };
    case 'purchase':
      return {
        icon: ShoppingCart,
        tone: 'bg-emerald-100 text-emerald-700',
        title: `Achat : ${str(d.product)}`,
        detail:
          [
            typeof d.amount === 'number' ? money(d.amount, d.currency) : null,
            d.source === 'webhook' ? 'via webhook' : d.source === 'api' ? 'via l’API' : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
      };
    default:
      return { icon: CircleDot, tone: 'bg-slate-100 text-slate-500', title: e.type };
  }
}

export function ContactDetailPage() {
  const { id } = useParams();
  const contactId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: c, setData, error, loading, reload } = useLoad(() => api.contact(contactId), [contactId]);
  const { data: allTags, reload: reloadTags } = useLoad(() => api.tags(), []);

  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [tagBusy, setTagBusy] = useState(false);
  const [resending, setResending] = useState(false);

  useEffect(() => {
    if (c) setForm({ email: c.email, first_name: c.first_name ?? '', last_name: c.last_name ?? '', phone: c.phone ?? '' });
  }, [c?.id, c?.email, c?.first_name, c?.last_name, c?.phone]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !c) return <PageLoader />;
  if (error && !c) return <ErrorState message={error} onRetry={reload} />;
  if (!c) return null;

  const dirty = form.email !== c.email || form.first_name !== (c.first_name ?? '') || form.last_name !== (c.last_name ?? '') || form.phone !== (c.phone ?? '');
  const merge = (updated: Partial<ContactDetail>) => setData({ ...c, ...updated, events: c.events });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const u = await api.updateContact(c.id, {
        email: form.email.trim(),
        first_name: form.first_name.trim() || null,
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim() || null,
      });
      merge(u);
      toast.success('Contact mis à jour');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const toggleUnsub = async (unsub: boolean) => {
    try {
      const u = await api.updateContact(c.id, { unsubscribed: unsub });
      merge(u);
      toast.success(unsub ? 'Contact désinscrit des emails' : 'Contact réabonné aux emails');
      reload();
    } catch (err) {
      toast.error(err);
    }
  };

  const addTag = async (e?: FormEvent) => {
    e?.preventDefault();
    const name = newTag.trim();
    if (!name) return;
    setTagBusy(true);
    try {
      const u = await api.addContactTag(c.id, name);
      merge(u);
      setNewTag('');
      reload();
      reloadTags();
    } catch (err) {
      toast.error(err);
    } finally {
      setTagBusy(false);
    }
  };

  const removeTag = async (tagId: number) => {
    try {
      const u = await api.removeContactTag(c.id, tagId);
      merge(u);
      reload();
    } catch (err) {
      toast.error(err);
    }
  };

  const resend = async () => {
    setResending(true);
    try {
      merge(await api.resendConfirmation(c.id));
      toast.success(`Nouvel email de confirmation envoyé à ${c.email}`);
      reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setResending(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: 'Supprimer ce contact ?',
      message: `${c.email} et tout son historique seront définitivement supprimés.`,
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await api.deleteContact(c.id);
      toast.success('Contact supprimé');
      navigate('/contacts');
    } catch (err) {
      toast.error(err);
    }
  };

  const name = contactName(c);
  const suggestions = (allTags ?? []).filter((t) => !c.tags.some((ct) => ct.id === t.id));
  const events = [...c.events].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);

  return (
    <>
      <Link to="/contacts" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
        <ArrowLeft size={16} /> Contacts
      </Link>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar text={initials(name)} seed={c.email} size={56} />
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <Mail size={14} /> {c.email}
              </span>
              <span className="text-slate-300">•</span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock size={14} /> Ajouté le {fmtDate(c.created_at)}
              </span>
              {c.unsubscribed ? (
                <Badge tone="red" dot>
                  {c.complained ? 'Désinscrit (plainte spam)' : 'Désinscrit'}
                </Badge>
              ) : c.status === 'pending_confirmation' ? (
                <Badge tone="amber" dot>
                  En attente de confirmation
                </Badge>
              ) : (
                <Badge tone="green" dot>
                  Abonné
                </Badge>
              )}
              {c.bounced ? (
                <span title="Le serveur du destinataire a définitivement refusé cette adresse : le contact est exclu de tous les envois.">
                  <Badge tone="red">
                    <MailX size={12} /> Adresse invalide (bounce)
                  </Badge>
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <Button variant="secondary" icon={Trash} className="text-rose-600 hover:text-rose-700" onClick={remove}>
          Supprimer
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Informations" />
            <form onSubmit={save} className="space-y-4">
              <Field label="Email">
                <Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Prénom">
                  <Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />
                </Field>
                <Field label="Nom">
                  <Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} />
                </Field>
              </div>
              <Field label="Téléphone">
                <Input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <div className="flex justify-end">
                <Button type="submit" loading={saving} disabled={!dirty}>
                  Enregistrer
                </Button>
              </div>
            </form>
          </Card>

          <ContactFieldsCard contact={c} onSaved={(u) => merge(u)} />
          <ContactOrders contactId={c.id} />
          <AffiliateMentionCard contactId={c.id} />

          <Card>
            <CardHeader title="Tags" description="Ajouter un tag peut inscrire le contact à une campagne." />
            <div className="mb-4 flex flex-wrap gap-2">
              {c.tags.length === 0 && <p className="text-sm text-slate-400">Aucun tag.</p>}
              {c.tags.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-1 rounded-lg bg-brand-50 py-1 pr-1 pl-2.5 text-sm font-medium text-brand-700 ring-1 ring-brand-200 ring-inset">
                  {t.name}
                  <button onClick={() => removeTag(t.id)} className="rounded p-0.5 text-brand-400 hover:bg-brand-100 hover:text-brand-700" title="Retirer">
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
            <form onSubmit={addTag} className="flex gap-2">
              <Input list="contact-tag-suggestions" icon={TagIcon} className="flex-1" placeholder="Ajouter un tag…" value={newTag} onChange={(e) => setNewTag(e.target.value)} />
              <datalist id="contact-tag-suggestions">
                {suggestions.map((t) => (
                  <option key={t.id} value={t.name} />
                ))}
              </datalist>
              <Button type="submit" variant="secondary" icon={Plus} loading={tagBusy} disabled={!newTag.trim()}>
                Ajouter
              </Button>
            </form>
          </Card>

          {c.status === 'pending_confirmation' && (
            <Card className="border-amber-200 bg-amber-50/60">
              <div className="flex items-start gap-3">
                <MailQuestion size={20} className="mt-0.5 shrink-0 text-amber-600" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-900">En attente de confirmation</p>
                  <p className="mt-1 text-sm text-amber-800">
                    Ce contact s’est inscrit via un formulaire en double opt-in mais n’a pas encore cliqué sur le lien reçu par email. Il ne reçoit ni newsletters ni
                    campagnes ; le tag et la campagne du formulaire seront appliqués à la confirmation. Il n’est jamais supprimé automatiquement.
                    {c.confirmation_sent_at && <> Dernier envoi : {fmtDateTime(c.confirmation_sent_at)}.</>}
                  </p>
                  <Button size="sm" variant="secondary" icon={RefreshCw} className="mt-3" onClick={resend} loading={resending} disabled={!!c.bounced}>
                    Renvoyer l’email de confirmation
                  </Button>
                </div>
              </div>
            </Card>
          )}

          <Card>
            <Toggle
              checked={!!c.unsubscribed}
              onChange={toggleUnsub}
              label="Désinscrit des emails"
              description="Un contact désinscrit ne reçoit plus aucune newsletter ni email de campagne."
            />
          </Card>
        </div>

        <Card className="lg:col-span-3">
          <CardHeader title="Historique" description={`${events.length} événement${events.length > 1 ? 's' : ''}`} icon={Clock} />
          {events.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">Aucun événement.</p>
          ) : (
            <ol className="relative">
              {events.map((e, i) => {
                const d = describeEvent(e);
                return (
                  <li key={e.id} className="relative flex gap-4 pb-6 last:pb-0">
                    {i < events.length - 1 && <span className="absolute top-9 bottom-0 left-[17px] w-px bg-slate-200" />}
                    <span className={cx('relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ring-4 ring-white', d.tone)}>
                      <d.icon size={16} />
                    </span>
                    <div className="min-w-0 flex-1 pt-1.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <p className="text-sm font-medium text-slate-900">{d.title}</p>
                        <time className="text-xs whitespace-nowrap text-slate-400" title={fmtDateTime(e.created_at)}>
                          {fmtRelative(e.created_at)}
                        </time>
                      </div>
                      {d.detail && <p className="mt-0.5 truncate text-sm text-slate-500">{d.detail}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>
      </div>
    </>
  );
}

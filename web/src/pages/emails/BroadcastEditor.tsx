import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Ban, CalendarClock, CalendarX, CircleCheck, CircleX, Ellipsis, Eye, FlaskConical, ListFilter, MailOpen, MousePointerClick, RotateCcw, Save, Send, Split, Users, Clock } from 'lucide-react';
import { renderEmailDocument, type Broadcast, type PageContent, type QueueStatus, type Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useBeforeUnload, useLoad, useNow, usePolling } from '../../lib/hooks';
import { fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtRate, fmtWeekdayDateTime, ratio } from '../../lib/format';
import { Builder, type BuilderHandle, type BuilderPanel } from '../../builder/Builder';
import { BarButton, PreviewMenu, SaveStatus } from '../../builder/bar';
import { Prop, inputCls } from '../../builder/controls';
import { PreheaderField } from '../../builder/Inspector';
import { DropdownMenu, type MenuEntry } from '../../components/Menu';
import { Badge, Button, Card, cx, ErrorState, Field, Input, Spinner, StatCard } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useUnsavedGuard } from '../../components/useUnsavedGuard';
import { EmailPreview, SAMPLE_VARS } from './EmailPreview';
import { countsOf, describeQueue, inProgress, LiveDot, ProgressLegend, StackedProgress, totalOf, useSendActions } from './queue';
import { AbResultsCard, AbTestModal, SendDialog } from './SendDialog';
import { SegmentPicker } from './SegmentPicker';

/** « ven. 2 oct. 10:00 » */
const fmtShortDateTime = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');

export function BroadcastPage() {
  const { id } = useParams();
  const bid = Number(id);
  const { data, setData, error, reload } = useLoad(async () => {
    const [b, tags] = await Promise.all([api.broadcast(bid), api.tags().catch(() => [] as Tag[])]);
    return { b, tags };
  }, [bid]);

  if (error && !data)
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  if (!data)
    return (
      <div className="flex h-full items-center justify-center bg-slate-100">
        <Spinner size={32} />
      </div>
    );

  if (data.b.status === 'sent') return <SentBroadcast b={data.b} tags={data.tags} />;
  return <BroadcastEditor key={data.b.id} initial={data.b} tags={data.tags} onSent={(b) => setData({ ...data, b })} />;
}

function BroadcastEditor({ initial, tags, onSent }: { initial: Broadcast; tags: Tag[]; onSent: (b: Broadcast) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [subject, setSubject] = useState(initial.subject);
  const [content, setContent] = useState<PageContent>(initial.content);
  const [saved, setSaved] = useState({ subject: initial.subject, json: JSON.stringify(initial.content) });
  const [tagId, setTagId] = useState<string>(initial.tag_id ? String(initial.tag_id) : '');
  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testEmail, setTestEmail] = useState(user?.email ?? '');
  const [testing, setTesting] = useState(false);
  // status / scheduled date / A/B config (saved separately from the content)
  const [meta, setMeta] = useState<Broadcast>(initial);
  const [sendOpen, setSendOpen] = useState<null | 'now' | 'schedule'>(null);
  const [abOpen, setAbOpen] = useState(false);
  const [unscheduling, setUnscheduling] = useState(false);
  const scheduled = meta.status === 'scheduled' && !!meta.scheduled_at;

  const builder = useRef<BuilderHandle>(null);
  // a scheduled newsletter starts by itself: switch to the sending view when it does
  usePolling(
    async () => {
      const b = await api.broadcast(initial.id);
      if (b.status === 'sent') onSent(b);
      else setMeta((m) => ({ ...m, status: b.status, scheduled_at: b.scheduled_at }));
    },
    10_000,
    scheduled,
  );

  const json = useMemo(() => JSON.stringify(content), [content]);
  const dirty = subject !== saved.subject || json !== saved.json;
  useBeforeUnload(dirty);
  useUnsavedGuard(dirty);

  const refreshCount = useCallback(async () => {
    setCountLoading(true);
    try {
      setCount((await api.recipientsCount(initial.id)).count);
    } catch {
      setCount(null);
    } finally {
      setCountLoading(false);
    }
  }, [initial.id]);
  useEffect(() => {
    refreshCount();
  }, [refreshCount]);

  const stateRef = useRef({ subject, content });
  stateRef.current = { subject, content };

  const save = useCallback(
    async (silent = false) => {
      const { subject: s, content: c } = stateRef.current;
      if (!s.trim()) {
        toast.error('L’objet de l’email est obligatoire.');
        return false;
      }
      setSaving(true);
      try {
        await api.updateBroadcast(initial.id, { subject: s.trim(), content: c });
        setSaved({ subject: s, json: JSON.stringify(c) });
        if (!silent) {
          setJustSaved(true);
          setTimeout(() => setJustSaved(false), 2000);
        }
        return true;
      } catch (e) {
        toast.error(e);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [initial.id, toast],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const changeTag = async (v: string) => {
    const prev = tagId;
    setTagId(v);
    try {
      await api.updateBroadcast(initial.id, { tag_id: v ? Number(v) : null });
      refreshCount();
    } catch (e) {
      setTagId(prev);
      toast.error(e);
    }
  };

  const sendTest = async (e: FormEvent) => {
    e.preventDefault();
    setTesting(true);
    try {
      if (dirty && !(await save(true))) return;
      await api.testBroadcast(initial.id, testEmail.trim());
      toast.success(`Email de test envoyé à ${testEmail.trim()}`);
      setTestOpen(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  const openSend = async (mode: 'now' | 'schedule') => {
    if (dirty && !(await save(true))) return;
    let n = count;
    try {
      n = (await api.recipientsCount(initial.id)).count;
      setCount(n);
    } catch {
      /* keep previous */
    }
    setSendOpen(mode);
  };

  const tagName = tagId ? tags.find((t) => String(t.id) === tagId)?.name : null;
  const segment = tagName ? `contacts ayant le tag « ${tagName} »` : 'tous vos contacts abonnés';

  const onSendDone = (b: Broadcast, mode: 'now' | 'schedule') => {
    setSendOpen(null);
    setSaved({ subject, json });
    if (mode === 'now') {
      toast.success('Newsletter en cours d’envoi 🚀');
      onSent({ ...b, status: 'sent' });
    } else {
      setMeta(b);
      toast.success('Newsletter programmée');
    }
  };

  const unschedule = async () => {
    const ok = await confirm({
      title: 'Annuler la programmation ?',
      message: 'La newsletter redevient un brouillon : elle ne partira pas tant que vous ne l’aurez pas envoyée ou reprogrammée.',
      confirmLabel: 'Annuler la programmation',
      cancelLabel: 'Garder la date',
    });
    if (!ok) return;
    setUnscheduling(true);
    try {
      setMeta(await api.unscheduleBroadcast(initial.id));
      toast.success('Programmation annulée : la newsletter est de nouveau un brouillon');
    } catch (e) {
      toast.error(e);
    } finally {
      setUnscheduling(false);
    }
  };

  const saveAb = async (ab_test: Broadcast['ab_test']) => {
    try {
      const b = await api.updateBroadcast(initial.id, { ab_test: ab_test ?? null });
      setMeta((m) => ({ ...m, ab_test: b.ab_test }));
      toast.success(ab_test ? 'Test A/B enregistré' : 'Test A/B désactivé');
    } catch (e) {
      toast.error(e);
      throw e;
    }
  };

  const abCount = meta.ab_test ? meta.ab_test.subjects.length + 1 : 0;
  const panels: BuilderPanel[] = [
    {
      id: 'send',
      label: 'Paramètres d’envoi',
      icon: Send,
      render: () => (
        <div className="scalo-scroll flex-1 space-y-5 overflow-y-auto border-t border-slate-100 px-4 py-4">
          <Prop label="Destinataires" hint="Les désinscrits et les contacts non confirmés (double opt-in) sont exclus automatiquement.">
            <select className={inputCls} value={tagId} onChange={(e) => changeTag(e.target.value)}>
              <option value="">Tous les contacts abonnés</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  Tag : {t.name}
                </option>
              ))}
            </select>
            <SegmentPicker broadcastId={initial.id} initial={initial.segment_id ?? null} onChanged={refreshCount} />
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-500">
              {countLoading ? <Spinner size={12} /> : <Users size={12} />}
              {count === null ? '—' : `${fmtNumber(count)} contact${count > 1 ? 's' : ''} aujourd’hui`}
            </p>
          </Prop>
          <Prop label="Test A/B de l’objet" hint="Envoyez plusieurs objets à un échantillon : le meilleur taux d’ouverture part automatiquement aux autres.">
            <button
              type="button"
              onClick={() => setAbOpen(true)}
              className="flex w-full items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-slate-300 hover:bg-slate-50"
            >
              <Split size={15} className={meta.ab_test ? 'text-violet-600' : 'text-slate-400'} />
              <span className="flex-1 text-slate-700">{meta.ab_test ? `Activé · ${abCount} objets` : 'Désactivé'}</span>
              <span className="text-xs font-medium text-brand-600">{meta.ab_test ? 'Modifier' : 'Configurer'}</span>
            </button>
          </Prop>
          <PreheaderField value={content.settings?.preheader} />
          <Prop label="Programmation">
            {scheduled ? (
              <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-900">
                <p className="flex items-center gap-1.5 font-medium">
                  <CalendarClock size={14} /> {fmtWeekdayDateTime(meta.scheduled_at!)}
                </p>
                <div className="mt-1.5 flex flex-col items-start gap-1 text-xs font-medium">
                  <button type="button" className="text-violet-700 hover:underline" onClick={() => openSend('schedule')}>
                    Modifier la date
                  </button>
                  <button type="button" className="text-rose-600 hover:underline" onClick={unschedule} disabled={unscheduling}>
                    Annuler la programmation
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => openSend('schedule')} className="text-sm font-medium text-brand-600 hover:underline">
                Programmer l’envoi…
              </button>
            )}
          </Prop>
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Builder
        ref={builder}
        content={content}
        onChange={setContent}
        mode="email"
        title={subject}
        panels={panels}
        barStart={
          <>
            <Link to="/emails?tab=broadcasts" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" title="Retour aux emails" aria-label="Retour aux emails">
              <ArrowLeft size={17} />
            </Link>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />
            <SubjectInput value={subject} onChange={setSubject} />
            <button
              type="button"
              onClick={() => (scheduled ? openSend('schedule') : builder.current?.openPanel('send'))}
              className={cx(
                'hidden shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap md:inline-flex',
                scheduled ? 'bg-violet-50 text-violet-700 hover:bg-violet-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70',
              )}
              title={scheduled ? 'Modifier ou annuler la programmation' : 'Paramètres d’envoi'}
            >
              {scheduled ? <CalendarClock size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />}
              {scheduled ? `Programmée · ${fmtShortDateTime(meta.scheduled_at!)}` : 'Brouillon'}
            </button>
          </>
        }
        barEnd={({ preview, togglePreview }) => (
          <>
            <SaveStatus saving={saving} dirty={dirty} detail={justSaved ? 'Enregistré à l’instant' : undefined} />
            <PreviewMenu
              preview={preview}
              onToggle={togglePreview}
              items={[
                { label: preview ? 'Revenir à l’édition' : 'Aperçu dans l’éditeur', description: 'Ordinateur, tablette ou mobile', icon: Eye, onClick: togglePreview },
                { label: 'Aperçu avec un contact d’exemple', description: 'Variables remplacées, pied d’email inclus', icon: MailOpen, onClick: () => setPreviewOpen(true) },
              ]}
            />
            <DropdownMenu
              items={[
                { label: 'Envoyer un test…', icon: FlaskConical, onClick: () => setTestOpen(true) },
                { label: meta.ab_test ? `Test A/B (${abCount} objets)…` : 'Test A/B de l’objet…', icon: Split, onClick: () => setAbOpen(true) },
                { label: 'Paramètres d’envoi', icon: Users, onClick: () => builder.current?.openPanel('send') },
                ...(scheduled ? (['sep', { label: 'Annuler la programmation', icon: CalendarX, danger: true, onClick: unschedule, disabled: unscheduling }] as MenuEntry[]) : []),
              ]}
              trigger={({ toggle, ref, open }) => (
                <button ref={ref} type="button" onClick={toggle} className={cx('inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900', open && 'bg-slate-100 text-slate-900')} title="Plus d’actions" aria-label="Plus d’actions">
                  <Ellipsis size={17} />
                </button>
              )}
            />
            <BarButton onClick={() => save()} disabled={saving || !dirty} title="Enregistrer (Ctrl+S)">
              <span className="hidden sm:inline">Enregistrer</span>
              <span className="sm:hidden">
                <Save size={15} />
              </span>
            </BarButton>
            <button
              type="button"
              onClick={() => openSend(scheduled ? 'schedule' : 'now')}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium whitespace-nowrap text-white shadow-xs hover:bg-brand-700"
            >
              <Send size={15} /> <span className="hidden sm:inline">Envoyer…</span>
            </button>
          </>
        )}
      />

      <EmailPreview open={previewOpen} onClose={() => setPreviewOpen(false)} content={content} subject={subject} />
      <SendDialog
        open={!!sendOpen}
        onClose={() => setSendOpen(null)}
        broadcast={meta}
        subject={subject}
        count={count}
        segment={segment}
        initialMode={sendOpen ?? 'now'}
        onDone={onSendDone}
        onUnschedule={async () => {
          setSendOpen(null);
          await unschedule();
        }}
      />
      <AbTestModal open={abOpen} onClose={() => setAbOpen(false)} subject={subject} value={meta.ab_test} onSave={saveAb} />

      <Modal
        open={testOpen}
        onClose={() => setTestOpen(false)}
        title="Envoyer un email de test"
        description="L’email est envoyé immédiatement à cette adresse (les modifications non enregistrées sont enregistrées avant)."
        footer={
          <>
            <Button variant="secondary" onClick={() => setTestOpen(false)}>
              Annuler
            </Button>
            <Button type="submit" form="test-email" icon={Send} loading={testing} disabled={!testEmail.trim()}>
              Envoyer le test
            </Button>
          </>
        }
      >
        <form id="test-email" onSubmit={sendTest}>
          <Field label="Adresse email" hint="Sans SMTP configuré, le test apparaît dans l’onglet « Suivi des envois ».">
            <Input type="email" required value={testEmail} onChange={(e) => setTestEmail(e.target.value)} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}

/** Subject of the email, editable inline in the top bar. */
export function SubjectInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Objet de l’email…"
      aria-label="Objet de l’email"
      title="Objet de l’email"
      className="h-8 w-full max-w-md min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-sm font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 hover:border-slate-200 focus:border-brand-400 focus:bg-white focus:ring-4 focus:ring-brand-500/10 focus:outline-none"
    />
  );
}

function SentBroadcast({ b, tags }: { b: Broadcast; tags: Tag[] }) {
  const [live, setLive] = useState(b);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const s = countsOf(live.stats);
  const active = inProgress(live.stats) || live.ab?.phase === 'testing';

  const refresh = useCallback(async () => {
    const [nb, q] = await Promise.all([api.broadcast(b.id), api.queue().catch(() => null)]);
    setLive(nb);
    if (q) setQueue(q);
  }, [b.id]);
  // live while sending (every 2 s), then slower for opens/clicks
  usePolling(refresh, active ? 2000 : 15000);
  const actions = useSendActions(() => refresh().catch(() => {}));

  const stats = live.stats ?? { sent: 0, opened: 0, clicked: 0, pending: 0, failed: 0 };
  const total = totalOf(s);
  const done = s.sent + s.failed;
  const job = queue?.jobs.find((j) => j.broadcast_id === live.id);
  const now = useNow(1000, active && (queue?.state === 'backoff' || queue?.state === 'daily_limit'));
  const qd = queue && active && queue.state !== 'sending' && queue.state !== 'idle' ? describeQueue(queue, now) : null;
  const tagName = live.tag_id ? tags.find((t) => t.id === live.tag_id)?.name ?? `#${live.tag_id}` : null;
  const html = useMemo(() => renderEmailDocument(live.content, { subject: live.subject, vars: SAMPLE_VARS, baseUrl: window.location.origin }), [live.content, live.subject]);
  const detailUrl = `/emails?tab=outbox&broadcast=${live.id}`;

  return (
    <div className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-4 sm:px-6">
          <Link to="/emails?tab=broadcasts" className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900">
            <ArrowLeft size={18} />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold text-slate-900">{live.subject}</h1>
            <p className="text-sm text-slate-500">
              {active ? 'Envoi lancé' : 'Envoyée'} le {fmtDateTime(live.sent_at)} · {tagName ? `Tag « ${tagName} »` : 'Tous les contacts abonnés'}
            </p>
          </div>
          {active ? (
            <Badge tone="blue">
              <LiveDot tone="sky" className="scale-75" /> En cours d’envoi
            </Badge>
          ) : (
            <Badge tone="green" dot>
              Envoyée
            </Badge>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        <Card className="mb-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                {active ? <LiveDot tone={qd ? qd.tone : 'green'} pulse={qd ? qd.pulse : true} /> : <CircleCheck size={16} className="text-emerald-500" />}
                {active ? 'Progression de l’envoi' : 'Envoi terminé'}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                {qd ? (
                  <span className="font-medium text-amber-700">{qd.sentence}</span>
                ) : active ? (
                  job && job.eta_seconds > 0 ? (
                    <span className="inline-flex items-center gap-1">
                      <Clock size={12} /> Fin estimée dans ~{fmtDuration(job.eta_seconds)}
                      {queue ? ` · ${fmtRate(queue.rate_per_minute)}` : ''}
                    </span>
                  ) : (
                    'Les emails partent progressivement, à la cadence définie dans les paramètres.'
                  )
                ) : (
                  `${fmtNumber(done)} email${done > 1 ? 's' : ''} traité${done > 1 ? 's' : ''} sur ${fmtNumber(total)}.`
                )}
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link to={detailUrl} className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-brand-700 hover:bg-brand-50">
                <ListFilter size={15} /> Voir le détail
              </Link>
              {s.failed > 0 && (
                <Button size="sm" variant="secondary" icon={RotateCcw} loading={actions.busy === `retry:${live.id}`} onClick={() => actions.retry(live.id)}>
                  Relancer les échecs
                </Button>
              )}
              {s.pending > 0 && (
                <Button
                  size="sm"
                  variant="secondary"
                  icon={Ban}
                  className="text-rose-600 hover:text-rose-700"
                  loading={actions.busy === `cancel:${live.id}`}
                  onClick={() => actions.cancel(live.id, live.subject, s.pending)}
                >
                  Annuler l’envoi
                </Button>
              )}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <StackedProgress c={s} className="flex-1" />
            <span className="w-12 text-right text-sm font-semibold text-slate-900 tabular-nums">{Math.floor(ratio(done, total) * 100)} %</span>
          </div>
          <div className="mt-2">
            <ProgressLegend c={s} />
          </div>
        </Card>

        {live.ab && <AbResultsCard ab={live.ab} />}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Destinataires" value={fmtNumber(total)} icon={Users} tone="brand" />
          <StatCard
            label="Envoyés"
            value={fmtNumber(s.sent)}
            icon={Send}
            tone="sky"
            hint={s.pending + s.sending ? `${fmtNumber(s.pending + s.sending)} en attente${s.sending ? ` (dont ${fmtNumber(s.sending)} en cours)` : ''}` : 'Tous traités'}
          />
          <StatCard label="Ouvertures" value={fmtPercent(ratio(stats.opened, s.sent))} icon={MailOpen} tone="green" hint={`${fmtNumber(stats.opened)} ouverture${stats.opened > 1 ? 's' : ''}`} />
          <StatCard label="Clics" value={fmtPercent(ratio(stats.clicked, s.sent))} icon={MousePointerClick} tone="amber" hint={`${fmtNumber(stats.clicked)} clic${stats.clicked > 1 ? 's' : ''}`} />
          <StatCard label="Échecs" value={fmtNumber(s.failed)} icon={s.failed ? CircleX : Clock} tone="rose" hint="Désinscrits, adresses invalides, erreurs SMTP, annulés" />
        </div>
        <Card className="mt-6" padded={false}>
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <h2 className="text-sm font-semibold text-slate-900">Contenu envoyé</h2>
            <span className="text-xs text-slate-500">Aperçu avec un contact d’exemple</span>
          </div>
          <iframe title="Email envoyé" sandbox="" srcDoc={html} className="h-[640px] w-full rounded-b-xl border-0 bg-slate-100" />
        </Card>
      </main>
    </div>
  );
}

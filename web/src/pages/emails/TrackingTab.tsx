// "Suivi des envois" tab: live queue panel + filterable outbox.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CircleCheck, CircleX, Clock, Eye, Inbox, Mail, MailCheck, Megaphone, MousePointerClick, RefreshCw, RotateCcw, Search, Send, SkipForward, Trash, Workflow, Ban, Loader, X } from 'lucide-react';
import type { Broadcast, Campaign, QueueStatus } from '@scalo/shared';
import { api, type OutboxItem, type OutboxStatus } from '../../lib/api';
import { useDebounced, useLoad, usePolling } from '../../lib/hooks';
import { fmtDateTime, fmtTimeOrDate } from '../../lib/format';
import { Badge, Button, Card, cx, EmptyState, ErrorState, Input, Pagination, Select, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { MAX_ATTEMPTS, QueuePanel, errorLabel } from './queue';

const OUTBOX_LIMIT = 50;

const STATUS_CHIPS: { id: OutboxStatus | ''; label: string }[] = [
  { id: '', label: 'Tous' },
  { id: 'pending', label: 'En attente' },
  { id: 'sending', label: 'En cours' },
  { id: 'sent', label: 'Envoyés' },
  { id: 'failed', label: 'Échecs' },
  { id: 'skipped', label: 'Ignorés' },
];

export function TrackingTab() {
  const [params, setParams] = useSearchParams();
  const broadcastParam = Number(params.get('broadcast')) || null;

  /* ----- live queue (every 2 s while the tab is visible) ----- */
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const loadQueue = useCallback(async () => {
    try {
      setQueue(await api.queue());
      setQueueError(null);
    } catch (e) {
      setQueueError((e as Error).message);
    }
  }, []);
  usePolling(loadQueue, 2000);

  /* ----- outbox ----- */
  const [status, setStatus] = useState<OutboxStatus | ''>('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 350);
  // the page is tied to the current filters: changing a filter goes back to page 1
  const filterKey = `${status}|${broadcastParam ?? ''}|${debouncedSearch.trim()}`;
  const [pageState, setPageState] = useState({ key: filterKey, page: 1 });
  const page = pageState.key === filterKey ? pageState.page : 1;
  const setPage = (p: number) => setPageState({ key: filterKey, page: p });
  const [data, setData] = useState<{ items: OutboxItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<OutboxItem | null>(null);
  const seq = useRef(0);

  const loadOutbox = useCallback(
    async (silent = false) => {
      const id = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const d = await api.outbox({ page, limit: OUTBOX_LIMIT, status, broadcast_id: broadcastParam, search: debouncedSearch });
        if (id === seq.current) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (id === seq.current) setError((e as Error).message);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    },
    [page, status, broadcastParam, debouncedSearch],
  );
  useEffect(() => {
    loadOutbox();
  }, [loadOutbox]);

  // auto-refresh every 5 s while the queue is doing something (keeps page and filters)
  const queueBusy = !!queue && queue.state !== 'idle';
  usePolling(() => loadOutbox(true), 5000, queueBusy);
  // one last refresh when the queue becomes idle, so the final statuses show up
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !queueBusy) loadOutbox(true);
    wasBusy.current = queueBusy;
  }, [queueBusy, loadOutbox]);

  const refreshAll = useCallback(
    (q?: QueueStatus) => {
      if (q) setQueue(q);
      else loadQueue();
      loadOutbox(true);
    },
    [loadQueue, loadOutbox],
  );

  const { data: labels } = useLoad(() => Promise.all([api.broadcasts().catch(() => [] as Broadcast[]), api.campaigns().catch(() => [] as Campaign[])]), []);
  const sentBroadcasts = (labels?.[0] ?? []).filter((b) => b.status === 'sent').sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''));

  const setBroadcastFilter = (id: number | null) => {
    const next = new URLSearchParams(params);
    next.set('tab', 'outbox');
    if (id) next.set('broadcast', String(id));
    else next.delete('broadcast');
    setParams(next, { replace: true });
  };

  const sourceLabel = (src: string) => {
    const [kind, id] = src.split(':');
    const n = Number(id);
    if (kind === 'broadcast') return { icon: Megaphone, text: labels?.[0].find((b) => b.id === n)?.subject ?? `Newsletter #${id}`, kind: 'Newsletter' };
    if (kind === 'campaign') return { icon: Workflow, text: labels?.[1].find((c) => c.id === n)?.name ?? `Campagne #${id}`, kind: 'Campagne' };
    if (kind === 'test') return { icon: Send, text: 'Envoi de test', kind: 'Test' };
    if (kind === 'confirmation') return { icon: MailCheck, text: 'Confirmation d’inscription', kind: 'Double opt-in' };
    if (kind === 'order') return { icon: MailCheck, text: 'Confirmation de commande', kind: 'Vente' };
    if (kind === 'deleted') return { icon: Trash, text: 'Source supprimée', kind: '' };
    return { icon: Mail, text: src, kind: '' };
  };

  const filtered = !!(status || broadcastParam || debouncedSearch.trim());

  return (
    <>
      <QueuePanel
        q={queue}
        error={queueError}
        onChange={refreshAll}
        onFilterBroadcast={(id) => {
          setBroadcastFilter(id);
          setTimeout(() => document.getElementById('outbox')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
        }}
      />

      <div id="outbox" className="mb-3 flex scroll-mt-4 flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-0.5 self-start rounded-lg bg-slate-200/60 p-0.5">
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.id || 'all'}
              onClick={() => setStatus(c.id)}
              className={cx(
                'h-7 rounded-md px-2.5 text-[13px] font-medium transition-colors',
                status === c.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500 hover:text-slate-900',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Input icon={Search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un email, un objet…" className="sm:w-64" />
          <Select value={broadcastParam ?? ''} onChange={(e) => setBroadcastFilter(Number(e.target.value) || null)} className="sm:w-60">
            <option value="">Toutes les sources</option>
            {broadcastParam && !sentBroadcasts.some((b) => b.id === broadcastParam) && <option value={broadcastParam}>Newsletter #{broadcastParam}</option>}
            {sentBroadcasts.map((b) => (
              <option key={b.id} value={b.id}>
                Newsletter : {b.subject || 'Sans objet'}
              </option>
            ))}
          </Select>
          <Button variant="secondary" icon={RefreshCw} onClick={() => refreshAll()} loading={loading && !!data} title="Actualiser" aria-label="Actualiser" className="px-2.5">
            <span className="sr-only">Actualiser</span>
          </Button>
        </div>
      </div>

      {broadcastParam && (
        <div className="mb-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 py-1 pr-1 pl-3 text-xs font-medium text-brand-700 ring-1 ring-brand-200 ring-inset">
            <Megaphone size={12} /> Filtré sur « {sourceLabel(`broadcast:${broadcastParam}`).text} »
            <button onClick={() => setBroadcastFilter(null)} className="rounded-full p-0.5 hover:bg-brand-100" title="Retirer le filtre">
              <X size={13} />
            </button>
          </span>
        </div>
      )}

      {error && !data ? (
        <ErrorState message={error} onRetry={() => loadOutbox()} />
      ) : !loading && data && data.total === 0 ? (
        filtered ? (
          <EmptyState icon={Search} title="Aucun envoi ne correspond" description="Modifiez les filtres ou la recherche." />
        ) : (
          <EmptyState icon={Inbox} title="Aucun envoi" description="Les emails envoyés par vos newsletters et campagnes apparaîtront ici." />
        )
      ) : (
        <Card padded={false} className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="px-4 py-3">Destinataire</th>
                  <th className="px-4 py-3">Objet</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-2 py-3 text-center" title="Tentatives">Essais</th>
                  <th className="px-2 py-3 text-center">Ouvert</th>
                  <th className="px-2 py-3 text-center">Cliqué</th>
                  <th className="px-4 py-3 text-right">Date</th>
                  <th className="px-2 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && !data
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 9 }).map((__, j) => (
                          <td key={j} className="px-4 py-3.5">
                            <Skeleton className="h-3.5 w-full max-w-[140px]" />
                          </td>
                        ))}
                      </tr>
                    ))
                  : data?.items.map((s) => (
                      <OutboxRow
                        key={s.id}
                        s={s}
                        src={sourceLabel(s.source)}
                        onOpen={() => setViewing(s)}
                        onRetried={(u) => {
                          setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === u.id ? { ...x, ...u } : x)) } : d));
                          refreshAll();
                        }}
                      />
                    ))}
              </tbody>
            </table>
          </div>
          {data && <Pagination page={page} total={data.total} limit={OUTBOX_LIMIT} onChange={setPage} />}
        </Card>
      )}
      <SendViewer send={viewing} onClose={() => setViewing(null)} />
    </>
  );
}

function OutboxRow({
  s,
  src,
  onOpen,
  onRetried,
}: {
  s: OutboxItem;
  src: { icon: typeof Mail; text: string; kind: string };
  onOpen: () => void;
  onRetried: (u: OutboxItem) => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const attempts = s.attempts ?? 0;
  const isRetry = s.status === 'pending' && attempts > 0;
  const canRetry = s.status === 'failed' && !s.source.startsWith('test');

  const retry = async () => {
    setRetrying(true);
    try {
      const u = await api.retrySend(s.id);
      toast.success(`Email à ${s.to_email} remis en file d’envoi`);
      onRetried(u);
    } catch (e) {
      toast.error(e);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <tr onClick={onOpen} className="cursor-pointer hover:bg-slate-50">
        <td className="px-4 py-3 font-medium whitespace-nowrap text-slate-900">{s.to_email}</td>
        <td className="max-w-[240px] truncate px-4 py-3 text-slate-700" title={s.subject}>
          {s.subject}
        </td>
        <td className="px-4 py-3">
          <span className="inline-flex max-w-[180px] items-center gap-1.5 text-xs text-slate-500" title={src.kind ? `${src.kind} : ${src.text}` : src.text}>
            <src.icon size={13} className="shrink-0" />
            <span className="truncate">{src.text}</span>
          </span>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-col items-start gap-1">
            <StatusBadge s={s} />
            {s.error && (s.status === 'failed' || s.status === 'skipped' || isRetry) && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setExpanded(!expanded);
                }}
                title={errorLabel(s.error)}
                className={cx('max-w-[200px] truncate text-left text-[11px] hover:underline', s.status === 'failed' ? 'text-rose-600' : 'text-amber-700')}
              >
                {errorLabel(s.error)}
              </button>
            )}
          </div>
        </td>
        <td className="px-2 py-3 text-center text-xs text-slate-500 tabular-nums">
          {attempts > 0 ? <span className={cx(attempts > 1 && 'font-semibold text-amber-700')}>{`${attempts}/${MAX_ATTEMPTS}`}</span> : '—'}
        </td>
        <td className="px-2 py-3 text-center">
          <Indicator on={!!s.opened_at} icon={Eye} title={s.opened_at ? `Ouvert le ${fmtDateTime(s.opened_at)}` : 'Non ouvert'} />
        </td>
        <td className="px-2 py-3 text-center">
          <Indicator on={!!s.clicked_at} icon={MousePointerClick} title={s.clicked_at ? `Cliqué le ${fmtDateTime(s.clicked_at)}` : 'Aucun clic'} />
        </td>
        <td className="px-4 py-3 text-right text-xs whitespace-nowrap text-slate-500">
          {isRetry ? (
            <span className="inline-flex items-center gap-1 text-amber-700" title={fmtDateTime(s.send_at)}>
              <RotateCcw size={12} /> Nouvelle tentative à {fmtTimeOrDate(s.send_at)}
            </span>
          ) : s.status === 'pending' ? (
            <span className="inline-flex items-center gap-1" title="Envoi programmé">
              <Clock size={12} /> {fmtDateTime(s.send_at)}
            </span>
          ) : (
            fmtDateTime(s.sent_at ?? s.send_at)
          )}
        </td>
        <td className="px-2 py-3 text-right">
          {canRetry && (
            <Button
              size="xs"
              variant="ghost"
              icon={RotateCcw}
              loading={retrying}
              onClick={(e) => {
                e.stopPropagation();
                retry();
              }}
            >
              Relancer
            </Button>
          )}
        </td>
      </tr>
      {expanded && s.error && (
        <tr className={s.status === 'failed' ? 'bg-rose-50/60' : 'bg-amber-50/60'}>
          <td colSpan={9} className="px-4 py-2.5 text-xs">
            <span className={cx('font-semibold', s.status === 'failed' ? 'text-rose-700' : 'text-amber-800')}>
              {s.status === 'failed' ? 'Erreur' : s.status === 'skipped' ? 'Raison' : `Erreur lors de la tentative ${attempts}/${MAX_ATTEMPTS}`} :
            </span>{' '}
            <span className="font-mono break-all text-slate-700">{s.error}</span>
          </td>
        </tr>
      )}
    </>
  );
}

function StatusBadge({ s }: { s: OutboxItem }) {
  if (s.status === 'sent')
    return (
      <Badge tone="green">
        <CircleCheck size={12} /> Envoyé
      </Badge>
    );
  if (s.status === 'skipped')
    return (
      <span title={s.error ?? undefined}>
        <Badge tone="slate">
          <SkipForward size={12} /> Ignoré
        </Badge>
      </span>
    );
  if (s.status === 'sending')
    return (
      <Badge tone="blue">
        <Loader size={12} className="animate-spin" /> En cours d’envoi
      </Badge>
    );
  if (s.status === 'failed') {
    if (s.error === 'Annulé')
      return (
        <Badge tone="slate">
          <Ban size={12} /> Annulé
        </Badge>
      );
    return (
      <span title={s.error ?? undefined}>
        <Badge tone="red">
          <CircleX size={12} /> {s.error === 'unsubscribed' ? 'Désinscrit' : 'Échec'}
        </Badge>
      </span>
    );
  }
  if ((s.attempts ?? 0) > 0)
    return (
      <Badge tone="amber">
        <RotateCcw size={12} /> Nouvel essai prévu
      </Badge>
    );
  const future = new Date(s.send_at).getTime() > Date.now() + 60_000;
  return (
    <Badge tone={future ? 'violet' : 'amber'}>
      <Clock size={12} /> {future ? 'Planifié' : 'En attente'}
    </Badge>
  );
}

function Indicator({ on, icon: Icon, title }: { on: boolean; icon: typeof Eye; title: string }) {
  return (
    <span title={title} className={cx('inline-flex h-7 w-7 items-center justify-center rounded-full', on ? 'bg-emerald-50 text-emerald-600' : 'text-slate-300')}>
      <Icon size={15} />
    </span>
  );
}

/**
 * Viewing a sent email must not count as an open or a click: drop the tracking pixel and make
 * links inert (target=_blank inside a sandbox without allow-popups does nothing).
 */
function neutralize(html: string) {
  const cleaned = html.replace(/<img[^>]+\/t\/o\/[^>]*>/gi, '');
  const base = '<base target="_blank"><style>a{cursor:default}</style>';
  return /<head[^>]*>/i.test(cleaned) ? cleaned.replace(/<head[^>]*>/i, (m) => m + base) : base + cleaned;
}

function SendViewer({ send, onClose }: { send: OutboxItem | null; onClose: () => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!send) return;
    let alive = true;
    setHtml(null);
    setErr(null);
    api
      .sendHtml(send.id)
      .then((h) => alive && setHtml(neutralize(h)))
      .catch((e) => alive && setErr((e as Error).message));
    return () => {
      alive = false;
    };
  }, [send]);

  return (
    <Modal
      open={!!send}
      onClose={onClose}
      size="xl"
      title={send?.subject}
      description={
        send ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>À : {send.to_email}</span>
            <StatusBadge s={send} />
            {!!send.attempts && (
              <span className="text-xs text-slate-500">
                Tentative{send.attempts > 1 ? 's' : ''} : {send.attempts}/{MAX_ATTEMPTS}
              </span>
            )}
            {send.error && (send.status === 'failed' || send.status === 'pending') && <span className="text-rose-600">{errorLabel(send.error)}</span>}
          </span>
        ) : undefined
      }
      bodyClassName="p-0"
    >
      <div className="h-[70vh] bg-slate-100">
        {err ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
            {send?.status === 'pending' || send?.status === 'sending' ? 'Cet email n’a pas encore été envoyé : son contenu sera disponible après l’envoi.' : err}
          </div>
        ) : html === null ? (
          <div className="flex h-full items-center justify-center">
            <RefreshCw className="animate-spin text-brand-500" size={24} />
          </div>
        ) : (
          <iframe title="Contenu de l’email" sandbox="" srcDoc={html} className="h-full w-full rounded-b-2xl border-0 bg-white" />
        )}
      </div>
    </Modal>
  );
}

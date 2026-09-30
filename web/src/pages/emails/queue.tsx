// Live sending queue: shared widgets (progress bar, state badge, job cards, queue panel).
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Ban,
  ChevronDown,
  CircleCheck,
  Clock,
  ExternalLink,
  Info,
  ListFilter,
  Pause,
  Play,
  RotateCcw,
  ShieldAlert,
  Split,
  TriangleAlert,
} from 'lucide-react';
import type { ComplaintStats, EmailStats, QueueJob, QueueStatus, UpcomingBroadcast } from '@scalo/shared';
import { api } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { fmtCountdown, fmtDateTime, fmtDuration, fmtNumber, fmtPercent, fmtRate, fmtTimeOrDate, fmtWeekdayDateTime, ratio } from '../../lib/format';
import { Badge, Button, Card, cx, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

export const MAX_ATTEMPTS = 4;

/* ---------------- progress bar ---------------- */

export interface Counts {
  sent: number;
  failed: number;
  sending: number;
  pending: number;
}

export const countsOf = (s?: Partial<EmailStats> | null): Counts => ({
  sent: s?.sent ?? 0,
  failed: s?.failed ?? 0,
  sending: s?.sending ?? 0,
  pending: s?.pending ?? 0,
});
export const totalOf = (c: Counts) => c.sent + c.failed + c.sending + c.pending;
export const inProgress = (s?: Partial<EmailStats> | null) => (s?.pending ?? 0) + (s?.sending ?? 0) > 0;

/** Stacked bar: sent (green) / failed (red) / sending (blue, animated) / pending (gray track). */
export function StackedProgress({ c, className, size = 'md' }: { c: Counts; className?: string; size?: 'sm' | 'md' }) {
  const total = totalOf(c) || 1;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className={cx('flex w-full overflow-hidden rounded-full bg-slate-200', size === 'sm' ? 'h-1.5' : 'h-2.5', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={c.sent + c.failed}
      title={`${fmtNumber(c.sent)} envoyé(s) · ${fmtNumber(c.sending)} en cours · ${fmtNumber(c.pending)} en attente · ${fmtNumber(c.failed)} échec(s)`}
    >
      {c.sent > 0 && <div className="h-full bg-emerald-500 transition-[width] duration-700" style={{ width: pct(c.sent) }} />}
      {c.failed > 0 && <div className="h-full bg-rose-500 transition-[width] duration-700" style={{ width: pct(c.failed) }} />}
      {c.sending > 0 && <div className="scalo-stripes h-full animate-stripes bg-sky-500 transition-[width] duration-700" style={{ width: pct(c.sending) }} />}
    </div>
  );
}

export function ProgressLegend({ c }: { c: Counts }) {
  const item = (color: string, label: string, n: number, extra?: string) => (
    <span className="inline-flex items-center gap-1.5">
      <span className={cx('h-2 w-2 rounded-full', color, extra)} />
      <span className="font-semibold text-slate-800 tabular-nums">{fmtNumber(n)}</span> {label}
    </span>
  );
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
      {item('bg-emerald-500', `envoyé${c.sent > 1 ? 's' : ''}`, c.sent)}
      {c.sending > 0 && item('bg-sky-500', 'en cours', c.sending, 'animate-pulse')}
      {item('bg-slate-300', 'en attente', c.pending)}
      {c.failed > 0 && item('bg-rose-500', `échec${c.failed > 1 ? 's' : ''}`, c.failed)}
    </div>
  );
}

/* ---------------- state ---------------- */

type DotTone = 'green' | 'amber' | 'orange' | 'violet' | 'slate' | 'sky';
const dotColors: Record<DotTone, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-400',
  sky: 'bg-sky-500',
};

export function LiveDot({ tone, pulse = true, className }: { tone: DotTone; pulse?: boolean; className?: string }) {
  return (
    <span className={cx('relative inline-flex h-2.5 w-2.5 shrink-0', className)}>
      {pulse && <span className={cx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-60', dotColors[tone])} />}
      <span className={cx('relative inline-flex h-2.5 w-2.5 rounded-full', dotColors[tone])} />
    </span>
  );
}

/** Human description of the queue state. `now` drives countdowns. */
export function describeQueue(q: QueueStatus, now: number): { tone: DotTone; pulse: boolean; label: string; sentence: string } {
  const resumeIn = q.resume_at ? Math.max(0, (new Date(q.resume_at).getTime() - now) / 1000) : null;
  switch (q.state) {
    case 'sending':
      return { tone: 'green', pulse: true, label: 'Envoi en cours', sentence: `Envoi en cours — ${fmtRate(q.rate_per_minute)}` };
    case 'paused':
      return { tone: 'amber', pulse: false, label: 'En pause', sentence: `En pause : ${q.paused_reason || 'mise en pause manuelle'}` };
    case 'backoff':
      return {
        tone: 'orange',
        pulse: true,
        label: 'Reprise automatique',
        sentence:
          resumeIn === null
            ? 'Serveur SMTP injoignable — nouvelle tentative prochainement'
            : resumeIn < 1
              ? 'Serveur SMTP injoignable — reprise imminente…'
              : `Serveur SMTP injoignable — reprise automatique dans ${fmtDuration(resumeIn)}`,
      };
    case 'daily_limit':
      return {
        tone: 'violet',
        pulse: false,
        label: 'Quota atteint',
        sentence: `Quota journalier atteint (${fmtNumber(q.daily_limit)}/24 h)${q.resume_at ? ` — reprise à ${fmtTimeOrDate(q.resume_at)}` : ''}`,
      };
    default:
      return {
        tone: 'slate',
        pulse: false,
        label: 'Inactif',
        sentence: q.scheduled > 0 ? `Aucun envoi en cours — ${fmtNumber(q.scheduled)} email${q.scheduled > 1 ? 's' : ''} planifié${q.scheduled > 1 ? 's' : ''}` : 'Aucun envoi en cours',
      };
  }
}

/* ---------------- actions ---------------- */

/** Cancel pending sends / retry failed sends of a newsletter, with confirm + toast. */
export function useSendActions(onDone?: () => void) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  const cancel = async (broadcastId: number, subject: string, pending: number) => {
    const ok = await confirm({
      title: 'Annuler l’envoi ?',
      message: (
        <>
          Les <strong>{fmtNumber(pending)}</strong> email{pending > 1 ? 's' : ''} encore en attente de « {subject} » ne seront pas envoyés (ils seront marqués « Annulé »).
          Les emails déjà partis ne peuvent pas être rappelés.
        </>
      ),
      confirmLabel: 'Annuler l’envoi',
      cancelLabel: 'Continuer l’envoi',
    });
    if (!ok) return;
    setBusy(`cancel:${broadcastId}`);
    try {
      const { count } = await api.cancelBroadcastSends(broadcastId);
      toast.success(count ? `${fmtNumber(count)} email${count > 1 ? 's' : ''} annulé${count > 1 ? 's' : ''}` : 'Plus aucun email en attente à annuler');
      onDone?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const retry = async (broadcastId?: number) => {
    setBusy(`retry:${broadcastId ?? 'all'}`);
    try {
      const { count } = await api.retryFailed(broadcastId);
      if (count) toast.success(`${fmtNumber(count)} email${count > 1 ? 's' : ''} remis en file d’envoi`);
      else toast.info('Aucun échec relançable (les contacts désinscrits ou en bounce sont exclus).');
      onDone?.();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return { cancel, retry, busy };
}

/* ---------------- queue panel ---------------- */

function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0" title={hint}>
      <dt className="truncate text-xs text-slate-500">{label}</dt>
      <dd className={cx('mt-0.5 text-lg font-semibold tracking-tight text-slate-900 tabular-nums', tone)}>{value}</dd>
    </div>
  );
}

export function QueuePanel({
  q,
  error,
  onChange,
  onFilterBroadcast,
}: {
  q: QueueStatus | null;
  error: string | null;
  onChange: (q?: QueueStatus) => void;
  onFilterBroadcast: (id: number) => void;
}) {
  const toast = useToast();
  const [toggling, setToggling] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const now = useNow(1000, q?.state === 'backoff' || q?.state === 'daily_limit' || (q?.jobs.some((j) => !j.done) ?? false));
  const actions = useSendActions(() => onChange());

  if (!q) {
    return error ? (
      <Card className="mb-6 border-rose-200 bg-rose-50 text-sm text-rose-700">Impossible de charger l’état de la file d’envoi : {error}</Card>
    ) : (
      <Card className="mb-6">
        <Skeleton className="h-5 w-72" />
        <Skeleton className="mt-4 h-10 w-full" />
      </Card>
    );
  }

  const d = describeQueue(q, now);
  const paused = q.state === 'paused';
  const togglePause = async () => {
    setToggling(true);
    try {
      const next = paused ? await api.resumeQueue() : await api.pauseQueue();
      toast.success(paused ? 'Envois repris' : 'Envois mis en pause');
      onChange(next);
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(false);
    }
  };

  const limitPct = q.daily_limit > 0 ? Math.min(1, q.sent_24h / q.daily_limit) : 0;
  const waiting = q.due + q.sending;
  const jobs = [...q.jobs].sort((a, b) => Number(a.done) - Number(b.done) || b.started_at.localeCompare(a.started_at));
  const totalErrors = q.recent_errors.reduce((a, e) => a + e.count, 0);
  const complaints = q.complaints;
  const complaintWarn = !!complaints && complaints.sent_30d > 0 && complaints.rate_30d > 0.001;

  return (
    <div className="mb-8 space-y-4">
      {complaintWarn && <ComplaintWarning c={complaints!} />}

      <Card padded={false}>
        <div className="flex flex-col gap-3 px-5 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <LiveDot tone={d.tone} pulse={d.pulse} />
            <div className="min-w-0">
              <p className="font-medium text-slate-900">{d.sentence}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {q.state === 'paused' ? (
                  waiting > 0 ? (
                    `${fmtNumber(waiting)} email${waiting > 1 ? 's' : ''} attendent la reprise.`
                  ) : (
                    'Aucun email ne partira tant que la file est en pause.'
                  )
                ) : q.due > 0 && q.eta_seconds > 0 ? (
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} /> Fin estimée dans ~{fmtDuration(q.eta_seconds)} · cadence {fmtRate(q.rate_per_minute)}
                  </span>
                ) : (
                  <>
                    Cadence {fmtRate(q.rate_per_minute)}
                    {q.daily_limit > 0 ? ` · ${fmtNumber(q.daily_limit)} max / 24 h` : ''} ·{' '}
                    <Link to="/settings#envoi" className="font-medium text-slate-600 hover:text-slate-900 hover:underline">
                      Régler
                    </Link>
                  </>
                )}
              </p>
            </div>
          </div>
          <Button size="sm" variant={paused ? 'success' : 'secondary'} icon={paused ? Play : Pause} onClick={togglePause} loading={toggling}>
            {paused ? 'Reprendre' : 'Mettre en pause'}
          </Button>
        </div>

        {q.dev_mode && (
          <p className="mx-5 mt-3 flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <TriangleAlert size={14} className="shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1">
              <strong>Mode développement</strong> : aucun SMTP configuré, les emails ne sont pas réellement délivrés.
            </span>
            <Link to="/settings#envoi" className="inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-2">
              Configurer <ExternalLink size={12} />
            </Link>
          </p>
        )}

        <dl className="mt-2 grid grid-cols-2 divide-slate-100 px-5 sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          <Stat label="À envoyer" value={fmtNumber(q.due)} hint={q.sending ? `+ ${fmtNumber(q.sending)} en cours` : 'Emails prêts à partir'} />
          <Stat label="Planifiés" value={fmtNumber(q.scheduled)} hint="Campagnes et envois différés" />
          <Stat label="Nouvelles tentatives" value={fmtNumber(q.retrying)} hint="Erreurs temporaires, retentées automatiquement" tone={q.retrying ? 'text-amber-600' : undefined} />
          <div className="min-w-0 px-4 py-3" title={q.daily_limit > 0 ? `Quota : ${fmtNumber(q.daily_limit)} / 24 h` : undefined}>
            <dt className="truncate text-xs text-slate-500">Envoyés 24 h</dt>
            <dd className="mt-0.5 text-lg font-semibold tracking-tight text-slate-900 tabular-nums">
              {fmtNumber(q.sent_24h)}
              {q.daily_limit > 0 && <span className="text-xs font-medium text-slate-400"> / {fmtNumber(q.daily_limit)}</span>}
            </dd>
            {q.daily_limit > 0 && (
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100">
                <div className={cx('h-full rounded-full', limitPct >= 1 ? 'bg-violet-500' : limitPct > 0.8 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${limitPct * 100}%` }} />
              </div>
            )}
          </div>
          <Stat label="Échecs 24 h" value={fmtNumber(q.failed_24h)} tone={q.failed_24h ? 'text-rose-600' : undefined} />
          <Stat label="Débit réel" value={`${fmtNumber(q.sent_last_minute)}/min`} hint={`Max ${fmtNumber(q.rate_per_minute)}/min`} />
        </dl>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 px-5 py-2.5">
          {complaints && (
            <span
              className={cx('inline-flex items-center gap-1.5 text-xs', complaintWarn ? 'font-medium text-rose-700' : 'text-slate-500')}
              title={`${fmtNumber(complaints.complaints_30d)} plainte(s) / ${fmtNumber(complaints.sent_30d)} envoi(s) sur 30 jours. Seuil d’alerte 0,1 % ; au-delà de 0,3 % sur les 1 000 derniers envois, l’envoi est mis en pause automatiquement.`}
            >
              <ShieldAlert size={13} className={complaintWarn ? 'text-rose-500' : 'text-slate-400'} />
              Plaintes (30 j) : <strong className="tabular-nums">{fmtPercent(complaints.rate_30d, 2)}</strong>
            </span>
          )}
          {q.recent_errors.length > 0 && (
            <button onClick={() => setErrorsOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-700 hover:text-rose-800" aria-expanded={errorsOpen}>
              <TriangleAlert size={13} /> {fmtNumber(totalErrors)} erreur{totalErrors > 1 ? 's' : ''} récente{totalErrors > 1 ? 's' : ''}
              <ChevronDown size={13} className={cx('transition-transform', errorsOpen && 'rotate-180')} />
            </button>
          )}
          <HowItWorks />
        </div>

        {errorsOpen && q.recent_errors.length > 0 && (
          <div className="border-t border-slate-100">
            <ul className="divide-y divide-slate-100">
              {q.recent_errors.map((e) => (
                <li key={e.error} className="flex items-start gap-3 px-5 py-2 text-sm">
                  <span className="mt-0.5 inline-flex min-w-8 justify-center rounded-md bg-rose-50 px-1.5 py-px text-xs font-semibold text-rose-700 tabular-nums">{fmtNumber(e.count)}</span>
                  <span className="min-w-0 flex-1 break-words text-slate-700">{errorLabel(e.error)}</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end px-5 py-2.5">
              <Button size="sm" variant="secondary" icon={RotateCcw} loading={actions.busy === 'retry:all'} onClick={() => actions.retry()}>
                Relancer tous les échecs
              </Button>
            </div>
          </div>
        )}
      </Card>

      {(q.upcoming?.length ?? 0) > 0 && <UpcomingList items={q.upcoming!} />}

      {jobs.length > 0 && (
        <Card padded={false}>
          <div className="border-b border-slate-100 px-5 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Newsletters en cours et des dernières 24 h</h3>
          </div>
          <ul className="divide-y divide-slate-100">
            {jobs.map((j) => (
              <JobRow key={j.broadcast_id} j={j} actions={actions} onFilter={() => onFilterBroadcast(j.broadcast_id)} />
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(!open)} className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-800" aria-expanded={open}>
        <Info size={13} /> Comment fonctionne l’envoi ?
        <ChevronDown size={13} className={cx('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul className="grid w-full gap-1.5 pt-2 pb-1 text-xs text-slate-600 md:grid-cols-2">
          <li>• Les emails partent à la cadence réglée dans les paramètres, pour ménager votre fournisseur SMTP et votre réputation d’expéditeur.</li>
          <li>• Les emails de confirmation (double opt-in) partent en premier, puis les emails de campagne, puis les newsletters.</li>
          <li>• Une newsletter programmée démarre toute seule à l’heure prévue ; un test A/B choisit ensuite l’objet gagnant et l’envoie au reste de la liste.</li>
          <li>• Une erreur temporaire (serveur occupé, limite…) est retentée automatiquement jusqu’à {MAX_ATTEMPTS} fois : après 1 min, 5 min puis 30 min.</li>
          <li>• Une adresse refusée définitivement est marquée « bounce » : le contact est exclu des prochains envois.</li>
          <li>• Si l’identifiant SMTP est refusé, la file se met en pause automatiquement : corrigez les paramètres puis cliquez sur « Reprendre ».</li>
          <li>• Si le serveur SMTP est injoignable, la file attend un peu puis reprend toute seule. Le quota journalier met aussi la file en attente.</li>
        </ul>
      )}
    </>
  );
}

export function errorLabel(error: string) {
  if (error === 'unsubscribed') return 'Contact désinscrit';
  return error;
}

function ComplaintWarning({ c }: { c: ComplaintStats }) {
  return (
    <div className="flex gap-2.5 rounded-xl bg-rose-50 p-4 text-sm text-rose-900">
      <ShieldAlert size={18} className="mt-px shrink-0 text-rose-600" />
      <p>
        <strong>Taux de plaintes élevé : {fmtPercent(c.rate_30d, 2)}</strong> sur 30 jours (seuil recommandé : 0,1 %). Gmail et Yahoo filtrent les expéditeurs au-delà de
        0,3 %. Retirez les contacts inactifs, n’écrivez qu’aux personnes qui l’ont demandé (activez le double opt-in) et rendez le lien de désinscription bien visible.
        {c.window_rate > 0.003 && c.window_sends >= 100 ? ' L’envoi a été mis en pause automatiquement.' : ''}
      </p>
    </div>
  );
}

function UpcomingList({ items }: { items: UpcomingBroadcast[] }) {
  const now = useNow(30_000);
  return (
    <Card padded={false}>
      <div className="border-b border-slate-100 px-5 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Newsletters programmées</h3>
      </div>
      <ul className="divide-y divide-slate-100">
        {items.map((u) => (
          <li key={u.broadcast_id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <Link to={`/emails/broadcasts/${u.broadcast_id}`} className="min-w-0 flex-1 truncate font-medium text-slate-900 hover:text-brand-700">
              {u.subject || 'Sans objet'}
            </Link>
            {u.ab && (
              <Badge tone="violet">
                <Split size={12} /> A/B
              </Badge>
            )}
            <span className="shrink-0 text-xs text-slate-500" title={`${fmtDateTime(u.scheduled_at)} — destinataires calculés au moment de l’envoi`}>
              {fmtWeekdayDateTime(u.scheduled_at)} · {fmtCountdown(u.scheduled_at, now)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function JobRow({ j, actions, onFilter }: { j: QueueJob; actions: ReturnType<typeof useSendActions>; onFilter: () => void }) {
  const c: Counts = { sent: j.sent, failed: j.failed, sending: j.sending, pending: j.pending };
  const total = j.total || totalOf(c);
  const done = j.sent + j.failed;
  const pct = ratio(done, total);
  return (
    <li className="grid gap-x-6 gap-y-2 px-5 py-3.5 lg:grid-cols-[minmax(0,1fr)_260px_auto] lg:items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {j.ab_phase === 'testing' && j.pending + j.sending === 0 ? (
            <span title={`Test A/B · gagnant ${j.ab_decide_at ? fmtCountdown(j.ab_decide_at) : 'bientôt'}`}>
              <Split size={14} className="text-violet-500" />
            </span>
          ) : j.done ? (
            <CircleCheck size={14} className="shrink-0 text-emerald-500" aria-label="Terminé" />
          ) : (
            <LiveDot tone="sky" className="scale-75" />
          )}
          <Link to={`/emails/broadcasts/${j.broadcast_id}`} className="truncate text-sm font-medium text-slate-900 hover:text-brand-700" title={j.subject}>
            {j.subject || 'Sans objet'}
          </Link>
        </div>
        <p className="mt-0.5 truncate pl-[22px] text-xs text-slate-500">
          {j.ab_phase === 'testing' && j.pending + j.sending === 0
            ? `Test A/B · gagnant ${j.ab_decide_at ? fmtCountdown(j.ab_decide_at) : 'bientôt'} · `
            : j.done
              ? 'Terminé · '
              : ''}
          {fmtDateTime(j.started_at)} · {fmtNumber(total)} destinataire{total > 1 ? 's' : ''} · {fmtPercent(ratio(j.opened, j.sent))} ouv. · {fmtPercent(ratio(j.clicked, j.sent))} clics
        </p>
      </div>
      <div className="min-w-0 pl-[22px] lg:pl-0">
        <div className="flex items-center gap-2.5">
          <StackedProgress c={c} size="sm" className="flex-1" />
          <span className="w-10 text-right text-xs font-medium text-slate-700 tabular-nums">{Math.floor(pct * 100)} %</span>
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          {fmtNumber(j.sent)} envoyé{j.sent > 1 ? 's' : ''}
          {j.pending > 0 ? ` · ${fmtNumber(j.pending)} en attente` : ''}
          {j.failed > 0 ? ` · ${fmtNumber(j.failed)} échec${j.failed > 1 ? 's' : ''}` : ''}
          {!j.done && j.pending > 0 && j.eta_seconds > 0 ? ` · ~${fmtDuration(j.eta_seconds)}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 pl-[22px] lg:justify-end lg:pl-0">
        <Button size="xs" variant="ghost" icon={ListFilter} onClick={onFilter}>
          Envois
        </Button>
        {j.failed > 0 && (
          <Button size="xs" variant="ghost" icon={RotateCcw} loading={actions.busy === `retry:${j.broadcast_id}`} onClick={() => actions.retry(j.broadcast_id)}>
            Relancer
          </Button>
        )}
        {j.pending > 0 && (
          <Button size="xs" variant="ghost" icon={Ban} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" loading={actions.busy === `cancel:${j.broadcast_id}`} onClick={() => actions.cancel(j.broadcast_id, j.subject, j.pending)}>
            Annuler
          </Button>
        )}
      </div>
    </li>
  );
}

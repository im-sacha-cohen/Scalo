// Newsletter sending: "Envoyer maintenant" / "Programmer" dialog, scheduled banner, A/B test settings and results.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { CalendarClock, CalendarX, Clock, FlaskConical, Globe, Send, ShieldAlert, Trophy, Users } from 'lucide-react';
import type { AbTestConfig, AbTestResult, Broadcast, DnsCheckResult } from '@scalo/shared';
import { api } from '../../lib/api';
import { useNow } from '../../lib/hooks';
import { fmtCountdown, fmtNumber, fmtPercent, fmtWeekdayDateTime, localTimeZone } from '../../lib/format';
import { Badge, Button, Card, cx, Field, Input, Select, Toggle } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { AiSubjectIdeas } from '../ai/AiRewrite';

const pad = (n: number) => String(n).padStart(2, '0');
const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Default slot: tomorrow 09:00 (local time). */
function defaultSlot(existing?: string | null) {
  if (existing) return new Date(existing);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

export const variantLabel = (i: number) => `Variante ${String.fromCharCode(65 + i)}`;

/** SPF / DKIM status of the sender domain, loaded once per dialog opening (null while loading or on error). */
function useDnsWarning(open: boolean) {
  const [dns, setDns] = useState<DnsCheckResult | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .dnsCheck()
      .then((r) => alive && setDns(r))
      .catch(() => alive && setDns(null));
    return () => {
      alive = false;
    };
  }, [open]);
  if (!dns) return null;
  const missing = dns.records.filter((r) => (r.kind === 'spf' || r.kind === 'dkim') && r.status !== 'ok').map((r) => r.kind.toUpperCase());
  return missing.length ? { domain: dns.domain, missing } : null;
}

export function SendDialog({
  open,
  onClose,
  broadcast,
  subject,
  count,
  segment,
  initialMode = 'now',
  onDone,
  onUnschedule,
}: {
  open: boolean;
  onClose: () => void;
  broadcast: Broadcast;
  subject: string;
  count: number | null;
  segment: string;
  initialMode?: 'now' | 'schedule';
  onDone: (b: Broadcast, mode: 'now' | 'schedule') => void;
  /** Shown when the newsletter is already scheduled. */
  onUnschedule?: () => void;
}) {
  const [mode, setMode] = useState<'now' | 'schedule'>(initialMode);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warning = useDnsWarning(open);
  const tz = useMemo(localTimeZone, []);

  useEffect(() => {
    if (!open) return;
    const d = defaultSlot(broadcast.status === 'scheduled' ? broadcast.scheduled_at : null);
    setMode(initialMode);
    setDate(toDateInput(d));
    setTime(toTimeInput(d));
    setError(null);
  }, [open, initialMode, broadcast.status, broadcast.scheduled_at]);

  const when = date && time ? new Date(`${date}T${time}`) : null; // local time
  const tooSoon = !!when && when.getTime() < Date.now() + 60_000;
  const tooLate = !!when && when.getTime() > Date.now() + 365 * 86400_000;
  const ab = broadcast.ab_test;
  const isScheduled = broadcast.status === 'scheduled' && !!broadcast.scheduled_at;
  const noRecipients = count === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const b = mode === 'now' ? await api.sendBroadcast(broadcast.id) : await api.scheduleBroadcast(broadcast.id, when!.toISOString());
      onDone(b, mode);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const option = (id: 'now' | 'schedule', icon: typeof Send, title: string, text: string) => {
    const Icon = icon;
    return (
      <button
        type="button"
        onClick={() => setMode(id)}
        className={cx(
          'flex flex-1 items-start gap-3 rounded-xl border p-3 text-left transition-colors',
          mode === id ? 'border-brand-500 bg-brand-50/60 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
        )}
      >
        <span className={cx('mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', mode === id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500')}>
          <Icon size={16} />
        </span>
        <span>
          <span className="block text-sm font-semibold text-slate-900">{title}</span>
          <span className="block text-xs text-slate-500">{text}</span>
        </span>
      </button>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Envoyer la newsletter"
      description={
        <>
          « <strong>{subject}</strong> » · {segment}
        </>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            type="submit"
            form="send-broadcast"
            variant={mode === 'now' ? 'success' : 'primary'}
            icon={mode === 'now' ? Send : CalendarClock}
            loading={busy}
            disabled={(mode === 'schedule' && (!when || tooSoon || tooLate)) || (mode === 'now' && noRecipients)}
          >
            {mode === 'now' ? 'Envoyer maintenant' : broadcast.status === 'scheduled' ? 'Modifier la date' : 'Programmer'}
          </Button>
        </>
      }
    >
      <form id="send-broadcast" onSubmit={submit} className="space-y-4">
        {isScheduled && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-violet-50 px-3 py-2 text-sm text-violet-900">
            <CalendarClock size={15} className="shrink-0 text-violet-600" />
            <span className="min-w-0 flex-1">
              Programmée pour le <strong>{fmtWeekdayDateTime(broadcast.scheduled_at!)}</strong> · {fmtCountdown(broadcast.scheduled_at!)}
            </span>
            {onUnschedule && (
              <button type="button" onClick={onUnschedule} className="inline-flex items-center gap-1 text-xs font-medium text-rose-600 hover:underline">
                <CalendarX size={13} /> Annuler la programmation
              </button>
            )}
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row">
          {option('now', Send, 'Envoyer maintenant', 'Les emails partent dès maintenant, à la cadence réglée.')}
          {option('schedule', CalendarClock, 'Programmer', 'Choisissez la date et l’heure d’envoi.')}
        </div>

        {mode === 'schedule' && (
          <div className="rounded-xl border border-slate-200 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date">
                <Input type="date" required value={date} min={toDateInput(new Date())} onChange={(e) => setDate(e.target.value)} />
              </Field>
              <Field label="Heure">
                <Input type="time" required value={time} step={60} onChange={(e) => setTime(e.target.value)} />
              </Field>
            </div>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-500">
              <Globe size={13} /> Fuseau horaire : {tz}
            </p>
            {when && !tooSoon && !tooLate && (
              <p className="mt-2 text-sm text-slate-700">
                Envoi le <strong>{fmtWeekdayDateTime(when.toISOString())}</strong> ({fmtCountdown(when.toISOString())}).
              </p>
            )}
            {tooSoon && <p className="mt-2 text-sm text-rose-600">Choisissez une date dans au moins 1 minute.</p>}
            {tooLate && <p className="mt-2 text-sm text-rose-600">La date d’envoi ne peut pas dépasser 1 an.</p>}
            <p className="mt-2 text-xs text-slate-500">
              La liste des destinataires est calculée au moment de l’envoi (nouveaux inscrits inclus, désinscrits exclus). Vous pourrez encore modifier le contenu
              jusque-là.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
          <Badge tone="brand">
            <Users size={12} /> {count === null ? '—' : `${fmtNumber(count)} destinataire${count > 1 ? 's' : ''} aujourd’hui`}
          </Badge>
          {ab && (
            <Badge tone="violet">
              <FlaskConical size={12} /> Test A/B : {ab.subjects.length + 1} objets
            </Badge>
          )}
        </div>
        {ab && (
          <p className="rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-900">
            {count !== null && count < 100
              ? `Moins de 100 destinataires : les ${ab.subjects.length + 1} objets sont répartis à parts égales, sans phase de test.`
              : `${ab.test_percent} % des destinataires reçoivent chaque objet ; ${ab.wait_hours} h plus tard, l’objet au meilleur taux d’ouverture est envoyé automatiquement aux autres.`}
          </p>
        )}

        {warning && (
          <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <ShieldAlert size={18} className="mt-px shrink-0 text-amber-600" />
            <p>
              Le domaine <strong>{warning.domain}</strong> n’est pas entièrement authentifié ({warning.missing.join(' et ')} manquant
              {warning.missing.length > 1 ? 's' : ''}) : vos emails risquent d’arriver en spam.{' '}
              <Link to="/settings#domaine" className="font-semibold underline">
                Configurer le domaine d’envoi
              </Link>
              . Vous pouvez tout de même envoyer.
            </p>
          </div>
        )}
        {mode === 'now' && noRecipients && <p className="text-sm text-rose-600">Aucun destinataire : aucun contact abonné ne correspond à ce segment.</p>}
        {mode === 'now' && !noRecipients && <p className="text-xs text-slate-500">Cette action est irréversible : les emails déjà partis ne peuvent pas être rappelés.</p>}
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </form>
    </Modal>
  );
}

const PERCENTS = [10, 15, 20, 25, 30];
const WAITS = [1, 2, 4, 8, 12, 24];

export function AbTestModal({
  open,
  onClose,
  subject,
  value,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  subject: string;
  value: AbTestConfig | null | undefined;
  onSave: (v: AbTestConfig | null) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(false);
  const [b, setB] = useState('');
  const [c, setC] = useState('');
  const [pct, setPct] = useState(20);
  const [wait, setWait] = useState(4);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEnabled(!!value);
    setB(value?.subjects[0] ?? '');
    setC(value?.subjects[1] ?? '');
    setPct(value?.test_percent ?? 20);
    setWait(value?.wait_hours ?? 4);
  }, [open, value]);

  const variants = 1 + Math.max(1, [b, c].filter((s) => s.trim()).length);
  const maxPct = Math.floor(100 / variants);
  const valid = !enabled || (b.trim() && pct * variants <= 100);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await onSave(enabled ? { subjects: [b, c].map((s) => s.trim()).filter(Boolean), test_percent: pct, wait_hours: wait } : null);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Test A/B de l’objet"
      description="Testez plusieurs objets sur une partie de vos contacts, puis envoyez automatiquement le meilleur aux autres."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="ab-test" loading={busy} disabled={!valid}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="ab-test" onSubmit={save} className="space-y-4">
        <Toggle checked={enabled} onChange={setEnabled} label="Activer le test A/B" description="Jusqu’à 3 objets. Le contenu de l’email est le même pour toutes les variantes." />
        {enabled && (
          <>
            <Field label={`${variantLabel(0)} (objet principal)`}>
              <Input value={subject} disabled />
            </Field>
            <Field label={variantLabel(1)}>
              <Input required value={b} onChange={(e) => setB(e.target.value)} placeholder="ex. {{first_name}}, votre invitation exclusive" maxLength={250} />
            </Field>
            <Field label={`${variantLabel(2)} (facultative)`}>
              <Input value={c} onChange={(e) => setC(e.target.value)} placeholder="Laisser vide pour tester 2 objets" maxLength={250} />
            </Field>
            <AiSubjectIdeas
              subject={subject}
              onPick={(picked) => {
                setB(picked[0] ?? '');
                setC(picked[1] ?? '');
              }}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Part de test par variante" hint={`${variants} × ${pct} % = ${variants * pct} % des destinataires en test`}>
                <Select value={pct} onChange={(e) => setPct(Number(e.target.value))}>
                  {PERCENTS.filter((p) => p <= maxPct).map((p) => (
                    <option key={p} value={p}>
                      {p} %
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Durée du test" hint="Puis envoi du gagnant au reste de la liste.">
                <Select value={wait} onChange={(e) => setWait(Number(e.target.value))}>
                  {WAITS.map((w) => (
                    <option key={w} value={w}>
                      {w} h
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              Le gagnant est l’objet au meilleur taux d’ouverture (à égalité : taux de clic). Avec moins de 100 destinataires, les objets sont simplement répartis à
              parts égales. Fonctionne aussi avec un envoi programmé.
            </p>
          </>
        )}
      </form>
    </Modal>
  );
}

export function AbResultsCard({ ab }: { ab: AbTestResult }) {
  const now = useNow(1000, ab.phase === 'testing');
  const best = ab.variants.reduce((m, v) => Math.max(m, v.open_rate), 0);
  return (
    <Card className="mb-6" padded={false}>
      <div className="flex flex-col gap-2 border-b border-slate-100 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FlaskConical size={16} className="text-violet-500" /> Test A/B de l’objet
        </h2>
        {ab.phase === 'testing' && ab.decide_at ? (
          <Badge tone="violet">
            <Clock size={12} /> Phase de test · gagnant choisi {fmtCountdown(ab.decide_at, now)}
          </Badge>
        ) : ab.split_only ? (
          <Badge tone="slate">Répartition égale (moins de 100 destinataires)</Badge>
        ) : ab.winner !== null ? (
          <Badge tone="green">
            <Trophy size={12} /> Gagnant : {variantLabel(ab.winner)} — envoyé au reste de la liste
          </Badge>
        ) : (
          <Badge tone="slate">Test annulé</Badge>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs font-medium text-slate-500">
              <th className="px-5 py-2">Variante</th>
              <th className="px-3 py-2">Objet</th>
              <th className="px-3 py-2 text-right">Test</th>
              <th className="px-3 py-2 text-right">Envoyés</th>
              <th className="px-3 py-2 text-right">Ouverture</th>
              <th className="px-5 py-2 text-right">Clics</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {ab.variants.map((v) => (
              <tr key={v.index} className={cx(ab.winner === v.index && 'bg-emerald-50/50')}>
                <td className="px-5 py-2.5 font-medium whitespace-nowrap text-slate-900">
                  <span className="inline-flex items-center gap-1.5">
                    {ab.winner === v.index && <Trophy size={14} className="text-amber-500" />}
                    {variantLabel(v.index)}
                  </span>
                </td>
                <td className="max-w-[280px] truncate px-3 py-2.5 text-slate-700" title={v.subject}>
                  {v.subject}
                </td>
                <td className="px-3 py-2.5 text-right text-slate-500 tabular-nums">{fmtNumber(v.test_recipients)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{fmtNumber(v.sent)}</td>
                <td className={cx('px-3 py-2.5 text-right font-semibold tabular-nums', v.open_rate === best && best > 0 ? 'text-emerald-700' : 'text-slate-900')}>
                  {fmtPercent(v.open_rate)}
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums">{fmtPercent(v.click_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

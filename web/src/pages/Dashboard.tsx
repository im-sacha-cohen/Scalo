import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ArrowUpRight, Eye, Funnel, Mail, MailOpen, Megaphone, MousePointerClick, UserPlus, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { markOnboardingSettled, onboardingApi, onboardingSettled } from '../lib/onboarding-api';
import { fmtNumber, fmtPercent, ratio } from '../lib/format';
import { useToast } from '../components/Toast';
import { Card, CardHeader, cx, ErrorState, PageLoader, Skeleton, StatCard } from '../components/ui';
import { RevenueCard } from './sales/SalesWidgets';
import { AffiliationCard } from './affiliates/AffiliateMentionCard';
import { StartChecklist } from './onboarding/StartChecklist';

const SERIES = [
  { key: 'views', label: 'Vues', color: '#5b4bff' },
  { key: 'optins', label: 'Optins', color: '#10b981' },
  { key: 'contacts', label: 'Nouveaux contacts', color: '#f59e0b' },
] as const;
type SeriesKey = (typeof SERIES)[number]['key'];

const shortDate = (d: string) => new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });

export function DashboardPage() {
  const { user } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api.dashboard(), []);
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({ views: false, optins: false, contacts: false });

  const hour = new Date().getHours();
  const hello = hour < 18 ? 'Bonjour' : 'Bonsoir';
  const firstName = user?.name?.split(' ')[0];

  // Onboarding: a new account goes through the welcome flow once (until finished or skipped); afterwards the
  // "Bien démarrer" checklist sits on top of the dashboard until it is complete or hidden (`?guide=1` reopens it).
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const guide = params.get('guide') === '1';
  const onboarding = useLoad(() => onboardingApi.get(), []);
  const [hiding, setHiding] = useState(false);
  const ob = onboarding.data;
  useEffect(() => {
    if (ob && !ob.required && user) markOnboardingSettled(user.id);
  }, [ob, user]);
  if (ob?.required) return <Navigate to="/welcome" replace />;
  // first visit of this browser: wait for the answer rather than flashing the dashboard before the welcome flow
  if (!ob && onboarding.loading && !(user && onboardingSettled(user.id))) return <PageLoader />;
  const showChecklist = !!ob && (guide || (!ob.checklist.hidden && !ob.checklist.complete));
  const hideChecklist = async () => {
    setHiding(true);
    try {
      onboarding.setData(await onboardingApi.update({ checklist_hidden: true }));
      if (guide) setParams({}, { replace: true });
      toast.info('Liste masquée. Vous la retrouverez dans le menu de votre compte, « Bien démarrer ».');
    } catch (e) {
      toast.error(e);
    } finally {
      setHiding(false);
    }
  };

  return (
    <>
      <section className="relative mb-6 overflow-hidden rounded-3xl bg-ink p-6 text-white sm:p-8">
        <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
          <div>
            <h1 className="text-[30px] leading-tight font-extrabold tracking-[-0.035em] sm:text-[36px]">
              {hello}
              {firstName ? ` ${firstName}` : ''} <span className="text-lime-400">👋</span>
            </h1>
            <p className="mt-2 max-w-md text-brand-200">Voici comment vos visiteurs montent les marches, sur les 30 derniers jours.</p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/funnels?new=1" className="inline-flex h-10 items-center gap-2 rounded-full bg-lime-400 px-5 text-sm font-semibold text-ink hover:bg-[#d4fa5c]">
                <Funnel size={16} /> Créer un tunnel
              </Link>
              <Link to="/emails?tab=broadcasts&new=1" className="inline-flex h-10 items-center gap-2 rounded-full border border-white/20 px-5 text-sm font-semibold text-white hover:bg-white/10">
                <Megaphone size={16} /> Nouvelle newsletter
              </Link>
            </div>
          </div>
          <JourneySteps data={data} />
        </div>
      </section>

      {showChecklist && ob && <StartChecklist state={ob} onHide={hideChecklist} hiding={hiding} />}

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {loading && !data ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i}>
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="mt-3 h-7 w-20" />
                  <Skeleton className="mt-4 h-3 w-32" />
                </Card>
              ))
            ) : data ? (
              <>
                <StatCard label="Emails envoyés (30 j)" value={fmtNumber(data.emails_sent_30d)} icon={Mail} tone="violet" hint="Newsletters et campagnes" />
                <StatCard label="Taux d’ouverture" value={fmtPercent(data.open_rate)} icon={MailOpen} tone="amber" hint="Sur les emails envoyés (30 j)" />
                <StatCard label="Tunnels" value={fmtNumber(data.funnels)} icon={Funnel} tone="rose" hint={<Link to="/funnels" className="font-medium text-brand-600 hover:underline">Gérer mes tunnels →</Link>} />
                {/* net revenue of the last 30 days, once the account has sold something */}
                <RevenueCard />
                {/* affiliation: sales brought by affiliates, once the program is on */}
                <AffiliationCard />
              </>
            ) : null}
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2">
              <CardHeader
                title="Activité sur 30 jours"
                description="Vues, optins et nouveaux contacts par jour"
                actions={
                  <div className="flex flex-wrap gap-1.5">
                    {SERIES.map((s) => (
                      <button
                        key={s.key}
                        onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}
                        className={cx(
                          'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                          hidden[s.key] ? 'border-slate-200 text-slate-400' : 'border-slate-200 bg-white text-slate-700 shadow-card',
                        )}
                      >
                        <span className="h-2 w-2 rounded-full" style={{ background: hidden[s.key] ? '#cbd5e1' : s.color }} />
                        {s.label}
                      </button>
                    ))}
                  </div>
                }
              />
              <div className="h-72">
                {loading && !data ? (
                  <Skeleton className="h-full w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={data?.daily ?? []} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                      <defs>
                        {SERIES.map((s) => (
                          <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={s.color} stopOpacity={0.25} />
                            <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={shortDate} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} minTickGap={24} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                      <Tooltip
                        labelFormatter={(l) => shortDate(String(l))}
                        contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', boxShadow: '0 10px 30px -10px rgba(15,23,42,.25)', fontSize: 13 }}
                      />
                      {SERIES.map((s) =>
                        hidden[s.key] ? null : (
                          <Area
                            key={s.key}
                            type="monotone"
                            dataKey={s.key}
                            name={s.label}
                            stroke={s.color}
                            strokeWidth={2}
                            fill={`url(#g-${s.key})`}
                            activeDot={{ r: 4, strokeWidth: 0 }}
                          />
                        ),
                      )}
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Actions rapides" description="Lancez-vous en un clic" />
              <div className="space-y-2">
                {[
                  { to: '/funnels?new=1', icon: Funnel, title: 'Créer un tunnel', desc: 'Page de capture, vente, remerciement', tone: 'bg-brand-50 text-brand-600' },
                  { to: '/emails?tab=broadcasts&new=1', icon: Megaphone, title: 'Nouvelle newsletter', desc: 'Envoyez un email à vos contacts', tone: 'bg-violet-50 text-violet-600' },
                  { to: '/contacts?import=1', icon: UserPlus, title: 'Importer des contacts', desc: 'Depuis un fichier CSV', tone: 'bg-emerald-50 text-emerald-600' },
                ].map((a) => (
                  <Link key={a.to} to={a.to} className="group flex items-center gap-3 rounded-xl border border-slate-200 p-3 transition-colors hover:border-brand-200 hover:bg-brand-50/40">
                    <span className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', a.tone)}>
                      <a.icon size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-slate-900">{a.title}</span>
                      <span className="block truncate text-xs text-slate-500">{a.desc}</span>
                    </span>
                    <ArrowUpRight size={16} className="text-slate-300 transition-colors group-hover:text-brand-600" />
                  </Link>
                ))}
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}

/** The logo's three steps, filled with real numbers: visitors → optins → contacts. */
function JourneySteps({ data }: { data: { views_30d: number; optins_30d: number; contacts: number; new_contacts_7d: number } | null | undefined }) {
  const v = (n: number | undefined) => (data ? fmtNumber(n ?? 0) : '—');
  const steps = [
    { label: 'Contacts', value: v(data?.contacts), sub: data ? `+${fmtNumber(data.new_contacts_7d)} cette semaine` : '', icon: Users, cls: 'bg-lime-400 text-ink', sub_cls: 'text-ink/70', indent: 'ml-16' },
    { label: 'Optins', value: v(data?.optins_30d), sub: data ? `${fmtPercent(ratio(data.optins_30d, data.views_30d))} des visiteurs` : '', icon: MousePointerClick, cls: 'bg-brand-500 text-white', sub_cls: 'text-brand-100', indent: 'ml-8' },
    { label: 'Visiteurs', value: v(data?.views_30d), sub: 'vues des pages', icon: Eye, cls: 'bg-brand-800 text-white', sub_cls: 'text-brand-200', indent: 'ml-0' },
  ];
  return (
    <div className="space-y-2">
      {steps.map((s) => (
        <div key={s.label} className={cx('flex w-[min(300px,calc(100vw-9rem))] items-center gap-3 rounded-full py-2.5 pr-5 pl-3', s.cls, s.indent)}>
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10">
            <s.icon size={15} />
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-[13px] font-semibold">{s.label}</span>
            <span className={cx('block truncate text-[11px]', s.sub_cls)}>{s.sub}</span>
          </span>
          <span className="font-display text-xl font-extrabold tracking-[-0.03em] tabular-nums">{s.value}</span>
        </div>
      ))}
    </div>
  );
}


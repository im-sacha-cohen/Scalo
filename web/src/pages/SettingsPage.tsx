import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { AppWindow, Blocks, Building2, CircleCheck, Gauge, Globe, Info, Lock, MailCheck, PlugZap, Server, UserRound, Webhook, type LucideIcon } from 'lucide-react';
import type { Settings } from '@scalo/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad } from '../lib/hooks';
import { fmtDuration, fmtNumber, fmtRate } from '../lib/format';
import { Button, Card, CardHeader, cx, ErrorState, Field, Input, PageHeader, PageLoader, Textarea, Toggle } from '../components/ui';
import { useToast } from '../components/Toast';
import { ConnectedAppsCard } from './oauth/ConnectedApps';
import { DomainCard, WebhookCard } from './DomainCard';
import { eeWeb } from '../lib/ee';
import { Sparkles } from 'lucide-react';
import { AiSettings } from './ai/AiSettingsCard';
import { CreditCard } from 'lucide-react';
import { StripeSettings } from './sales/StripeSettingsCard';
import { DatabaseZap } from 'lucide-react';
import { AccountDataSection } from './settings/AccountDataSection';

const EMPTY: Settings = {
  sender_name: '',
  sender_email: '',
  company_address: '',
  smtp_host: '',
  smtp_port: 587,
  smtp_user: '',
  smtp_pass: '',
  smtp_secure: false,
  rate_per_minute: 60,
  daily_limit: 0,
  double_optin_default: false,
};

const RATE_PRESETS = [30, 60, 120, 300];

type SectionId = 'expediteur' | 'envoi' | 'domaine' | 'paiements' | 'applications' | 'integrations' | 'ia' | 'compte';
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'expediteur', label: 'Expéditeur & adresse', icon: UserRound },
  { id: 'envoi', label: 'Envoi', icon: Server },
  { id: 'domaine', label: 'Domaine d’envoi', icon: Globe },
  { id: 'paiements', label: 'Paiements', icon: CreditCard },
  { id: 'applications', label: 'Applications connectées', icon: AppWindow },
  { id: 'integrations', label: 'Intégrations', icon: Webhook },
  { id: 'ia', label: 'IA', icon: Sparkles },
];
// Enterprise edition, when ee/ is installed: license, team, audit log, white label
const EE_SECTIONS = eeWeb?.settingsSections ?? [];
for (const s of EE_SECTIONS) SECTIONS.push({ id: s.id as SectionId, label: s.label, icon: s.icon });
// last: export, deletion of the data, deletion of the account (owner only)
SECTIONS.push({ id: 'compte', label: 'Données et compte', icon: DatabaseZap });
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));

export function SettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { data, setData, error, loading, reload } = useLoad(() => api.settings(), []);
  const [form, setForm] = useState<Settings>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (data) setForm({ ...EMPTY, ...data, smtp_pass: '' });
  }, [data]);
  // one section at a time; the hash keeps the section (/settings#domaine is linked from the send dialog)
  const [section, setSectionState] = useState<SectionId>(() => {
    const h = window.location.hash.slice(1) as SectionId;
    return SECTIONS.some((x) => x.id === h) ? h : 'expediteur';
  });
  const setSection = (id: SectionId) => {
    setSectionState(id);
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${id}`);
    window.scrollTo({ top: 0 });
  };

  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { smtp_configured: _ignored, webhook_secret: _s, webhook_base_url: _u, dkim_selectors: _d, ...payload } = form;
      void _ignored;
      void _s;
      void _u;
      void _d;
      const s = await api.saveSettings({
        ...payload,
        smtp_port: Number(payload.smtp_port) || 0,
        rate_per_minute: clamp(Number(payload.rate_per_minute), 1, 1000),
        daily_limit: clamp(Number(payload.daily_limit), 0, 1_000_000),
      });
      setData(s);
      toast.success('Paramètres enregistrés');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const configured = !!data?.smtp_configured;
  const smtpDirty =
    !!data &&
    (form.smtp_host !== data.smtp_host ||
      Number(form.smtp_port) !== Number(data.smtp_port) ||
      form.smtp_user !== data.smtp_user ||
      form.smtp_secure !== data.smtp_secure ||
      form.smtp_pass !== '');

  const testSmtp = async () => {
    setTesting(true);
    try {
      await api.testSmtp();
      toast.success(`Connexion SMTP réussie (${data?.smtp_host})`);
    } catch (err) {
      toast.error(err instanceof Error ? `Échec de la connexion SMTP : ${err.message}` : err);
    } finally {
      setTesting(false);
    }
  };

  const rate = Number(form.rate_per_minute) || 0;
  const daily = Number(form.daily_limit) || 0;
  const rateValid = rate >= 1 && rate <= 1000;
  const dailyValid = daily >= 0 && daily <= 1_000_000;
  // time to send 1000 emails at this rate (and with the daily quota if it is lower)
  const thousandSeconds = rateValid ? (1000 / rate) * 60 : 0;

  const dirty =
    !!data &&
    (form.sender_name !== data.sender_name ||
      form.sender_email !== data.sender_email ||
      form.company_address !== data.company_address ||
      Number(form.rate_per_minute) !== Number(data.rate_per_minute) ||
      Number(form.daily_limit) !== Number(data.daily_limit) ||
      !!form.double_optin_default !== !!data.double_optin_default ||
      smtpDirty);
  const inForm = section === 'expediteur' || section === 'envoi';

  return (
    <>
      <PageHeader title="Paramètres" description="Expéditeur, envoi des emails, domaine, applications connectées et données du compte." />

      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <nav className="-mx-4 flex shrink-0 gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:w-52 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0" aria-label="Sections des paramètres">
          {SECTIONS.map((x) => (
            <button
              key={x.id}
              type="button"
              onClick={() => setSection(x.id)}
              aria-current={section === x.id ? 'page' : undefined}
              className={cx(
                'flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors',
                section === x.id ? 'bg-white text-slate-900 shadow-xs ring-1 ring-slate-200' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
              )}
            >
              <x.icon size={16} className={section === x.id ? 'text-brand-600' : 'text-slate-400'} />
              {x.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => navigate('/developers')}
            className="flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium whitespace-nowrap text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900"
          >
            <Blocks size={16} className="text-slate-400" />
            Développeurs
          </button>
        </nav>

        <div className="min-w-0 max-w-3xl flex-1">
          {inForm && (
            <form id="settings-form" onSubmit={submit} className="space-y-6">
              {section === 'expediteur' && (
                <>
                  <Card>
                    <CardHeader icon={UserRound} title="Expéditeur" description="Ce que vos contacts voient dans leur boîte de réception." />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <Field label="Nom de l’expéditeur">
                        <Input value={form.sender_name} onChange={(e) => set('sender_name', e.target.value)} placeholder={user?.name || 'Marie de Mon Entreprise'} />
                      </Field>
                      <Field label="Email de l’expéditeur" hint="Une adresse de votre domaine améliore la délivrabilité.">
                        <Input type="email" value={form.sender_email} onChange={(e) => set('sender_email', e.target.value)} placeholder="bonjour@mon-entreprise.fr" />
                      </Field>
                    </div>
                  </Card>
                  <Card>
                    <CardHeader icon={Building2} title="Adresse de l’entreprise" description="Obligatoire légalement : ajoutée en pied de chaque email." />
                    <Textarea rows={4} aria-label="Adresse postale" value={form.company_address} onChange={(e) => set('company_address', e.target.value)} placeholder={'Mon Entreprise SAS\n12 rue de la Paix\n75002 Paris, France'} />
                  </Card>
                </>
              )}

              {section === 'envoi' && (
                <>
                  <div className={cx('flex items-start gap-2.5 rounded-lg px-3.5 py-2.5 text-sm', configured ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-900')}>
                    {configured ? <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-600" /> : <Info size={16} className="mt-0.5 shrink-0 text-amber-600" />}
                    <p>
                      {configured ? (
                        <>
                          Envoi via <strong>{data?.smtp_host}</strong>.
                        </>
                      ) : (
                        <>
                          <strong>Mode développement</strong> : sans serveur SMTP, les emails ne partent pas réellement.
                        </>
                      )}{' '}
                      Chaque envoi est visible dans{' '}
                      <Link to="/emails?tab=outbox" className="font-medium underline underline-offset-2">
                        Suivi des envois
                      </Link>
                      .
                    </p>
                  </div>

                  <Card>
                    <CardHeader icon={Server} title="Serveur SMTP" description="Brevo, Mailgun, Amazon SES, OVH, Gmail… tout fournisseur SMTP fonctionne." />
                    <div className="grid gap-4 md:grid-cols-6">
                      <Field label="Hôte" className="md:col-span-4">
                        <Input value={form.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} placeholder="smtp.exemple.com" autoComplete="off" />
                      </Field>
                      <Field label="Port" className="md:col-span-2">
                        <Input type="number" min={1} max={65535} value={form.smtp_port || ''} onChange={(e) => set('smtp_port', Number(e.target.value))} placeholder="587" />
                      </Field>
                      <Field label="Utilisateur" className="md:col-span-3">
                        <Input value={form.smtp_user} onChange={(e) => set('smtp_user', e.target.value)} autoComplete="off" />
                      </Field>
                      <Field label="Mot de passe" className="md:col-span-3">
                        <Input
                          icon={Lock}
                          type="password"
                          value={form.smtp_pass}
                          onChange={(e) => set('smtp_pass', e.target.value)}
                          placeholder={configured ? '•••••••• (inchangé)' : ''}
                          autoComplete="new-password"
                        />
                      </Field>
                      <div className="md:col-span-6">
                        <Toggle
                          checked={form.smtp_secure}
                          onChange={(v) => {
                            set('smtp_secure', v);
                            if (v && form.smtp_port === 587) set('smtp_port', 465);
                            if (!v && form.smtp_port === 465) set('smtp_port', 587);
                          }}
                          label="Connexion sécurisée (SSL/TLS)"
                          description="Port 465. Désactivé : port 587 (STARTTLS)."
                        />
                      </div>
                      <div className="flex flex-col gap-2 border-t border-slate-100 pt-4 sm:flex-row sm:items-center sm:justify-between md:col-span-6">
                        <p className="text-xs text-slate-500">
                          {!configured
                            ? 'Enregistrez un serveur SMTP pour pouvoir tester la connexion.'
                            : smtpDirty
                              ? 'Le test utilise les paramètres enregistrés : enregistrez d’abord.'
                              : 'Vérifie que le serveur accepte vos identifiants (aucun email envoyé).'}
                        </p>
                        <Button variant="secondary" size="sm" icon={PlugZap} onClick={testSmtp} loading={testing} disabled={!configured}>
                          Tester la connexion
                        </Button>
                      </div>
                    </div>
                  </Card>

                  <Card>
                    <CardHeader icon={Gauge} title="Cadence d’envoi" description="Les emails partent progressivement pour respecter les limites de votre fournisseur." />
                    <div className="grid gap-6 md:grid-cols-2">
                      <div>
                        <Field
                          label="Emails par minute"
                          error={rateValid ? null : 'Entre 1 et 1 000 emails par minute.'}
                          hint={
                            rateValid ? (
                              <>
                                {fmtNumber(rate * 60)} emails/heure · 1 000 emails en ~{fmtDuration(thousandSeconds)}
                                {daily > 0 && daily < 1000 ? ` (hors quota de ${fmtNumber(daily)})` : ''}
                              </>
                            ) : undefined
                          }
                        >
                          <Input type="number" min={1} max={1000} step={1} value={form.rate_per_minute || ''} onChange={(e) => set('rate_per_minute', Number(e.target.value))} placeholder="60" />
                        </Field>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {RATE_PRESETS.map((p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => set('rate_per_minute', p)}
                              title={fmtRate(p)}
                              className={cx(
                                'h-7 rounded-md px-2.5 text-xs font-medium transition-colors',
                                rate === p ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200 hover:text-slate-900',
                              )}
                            >
                              {p}/min
                            </button>
                          ))}
                        </div>
                      </div>
                      <Field
                        label="Limite par 24 heures"
                        error={dailyValid ? null : 'Entre 0 et 1 000 000 (0 = illimité).'}
                        hint={daily > 0 ? `Au-delà de ${fmtNumber(daily)} emails sur 24 h, la file attend. Gmail ~500/jour, Brevo gratuit 300/jour.` : '0 = illimité. Gmail ~500/jour, Brevo gratuit 300/jour.'}
                      >
                        <Input type="number" min={0} max={1000000} step={1} value={Number.isFinite(form.daily_limit) ? form.daily_limit : 0} onChange={(e) => set('daily_limit', Number(e.target.value))} placeholder="0" />
                      </Field>
                    </div>
                    <p className="mt-4 text-xs text-slate-500">Les emails de campagne passent avant les newsletters ; les erreurs temporaires sont retentées automatiquement (4 tentatives).</p>
                  </Card>

                  <Card>
                    <CardHeader icon={MailCheck} title="Double opt-in" description="Le contact confirme son inscription via un lien reçu par email : liste plus propre, preuve de consentement (RGPD)." />
                    <Toggle
                      checked={!!form.double_optin_default}
                      onChange={(v) => set('double_optin_default', v)}
                      label="Activer par défaut sur les formulaires"
                      description="Pour les formulaires réglés sur « Par défaut du compte ». Tant qu’il n’a pas confirmé, le contact ne reçoit ni newsletters ni campagnes."
                    />
                  </Card>
                </>
              )}

              {/* sticky save bar, only with unsaved changes */}
              {(dirty || saving) && (
                <div className="sticky bottom-4 z-10 flex animate-pop-in items-center justify-between gap-3 rounded-xl bg-slate-900 py-2 pr-2 pl-4 text-sm text-white shadow-pop">
                  <span>Modifications non enregistrées</span>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => data && setForm({ ...EMPTY, ...data, smtp_pass: '' })} className="h-8 rounded-lg px-3 text-slate-300 hover:bg-white/10 hover:text-white">
                      Annuler
                    </button>
                    <Button type="submit" size="sm" loading={saving} disabled={!rateValid || !dailyValid}>
                      Enregistrer
                    </Button>
                  </div>
                </div>
              )}
            </form>
          )}

          {section === 'domaine' && data && (
            <div className="space-y-6">
              <DomainCard key={data.sender_email} settings={data} onSettings={setData} />
            </div>
          )}
          {section === 'integrations' && data && <WebhookCard settings={data} onSettings={setData} />}
          {section === 'applications' && <ConnectedAppsCard />}
          {EE_SECTIONS.map((s) => section === (s.id as SectionId) && <s.Component key={s.id} />)}
          {section === 'ia' && <AiSettings />}
          {section === 'paiements' && <StripeSettings />}
          {section === 'compte' && <AccountDataSection />}
        </div>
      </div>
    </>
  );
}

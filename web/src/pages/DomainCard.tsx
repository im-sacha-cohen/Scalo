// Settings → "Domaine d'envoi" (SPF / DKIM / DMARC / MX check with real DNS lookups) and provider webhooks.
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, CircleCheck, CircleX, Copy, Globe, KeyRound, RefreshCw, RotateCw, TriangleAlert, Webhook } from 'lucide-react';
import type { DnsCheckResult, DnsRecordCheck, Settings } from '@scalo/shared';
import { api } from '../lib/api';
import { copyText } from '../lib/hooks';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, CardHeader, cx, Field, Input, Select } from '../components/ui';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';

const FREE_DOMAINS = ['gmail.com', 'googlemail.com', 'outlook.com', 'outlook.fr', 'hotmail.com', 'hotmail.fr', 'yahoo.com', 'yahoo.fr', 'orange.fr', 'free.fr', 'laposte.net', 'icloud.com', 'live.fr', 'sfr.fr', 'wanadoo.fr'];

const KIND_LABEL: Record<DnsRecordCheck['kind'], { title: string; what: string }> = {
  spf: { title: 'SPF', what: 'Liste les serveurs autorisés à envoyer des emails pour votre domaine.' },
  dkim: { title: 'DKIM', what: 'Signature cryptographique qui prouve que l’email n’a pas été modifié et vient bien de vous.' },
  dmarc: { title: 'DMARC', what: 'Indique aux boîtes de réception quoi faire si SPF/DKIM échouent, et vous envoie des rapports.' },
  mx: { title: 'MX', what: 'Serveurs qui reçoivent les emails de votre domaine (réponses, retours).' },
};

type ProviderId = NonNullable<DnsCheckResult['provider']>;
const PROVIDERS: Record<Exclude<ProviderId, 'other'>, { name: string; steps: ReactNode[] }> = {
  brevo: {
    name: 'Brevo',
    steps: [
      'Brevo → Paramètres → Expéditeurs, domaines et IP dédiées → Domaines → « Ajouter un domaine ».',
      'Brevo affiche les enregistrements à créer : un TXT « brevo-code », deux CNAME DKIM (brevo1._domainkey et brevo2._domainkey) et un DMARC.',
      'SPF : ajoutez « include:spf.brevo.com » à votre enregistrement SPF (un seul enregistrement « v=spf1 » par domaine).',
      'Revenez dans Brevo et cliquez sur « Authentifier ce domaine », puis sur « Revérifier » ici.',
    ],
  },
  mailgun: {
    name: 'Mailgun',
    steps: [
      'Mailgun → Send → Sending → Domains → « Add new domain » (Mailgun conseille un sous-domaine, ex. mg.votre-domaine.fr).',
      'Créez les enregistrements indiqués : TXT SPF « v=spf1 include:mailgun.org ~all », TXT DKIM sur <sélecteur>._domainkey, MX mxa/mxb.mailgun.org.',
      'Ajoutez le sélecteur DKIM de Mailgun (visible dans le nom de l’enregistrement, ex. « pic » ou « mx ») dans « Sélecteurs DKIM » ci-dessous si nécessaire.',
      'Cliquez sur « Verify DNS settings » dans Mailgun.',
    ],
  },
  ses: {
    name: 'Amazon SES',
    steps: [
      'AWS → Amazon SES → Configuration → Identities → « Create identity » → Domain, avec « Easy DKIM » (RSA 2048).',
      'Publiez les 3 CNAME « <jeton>._domainkey » → « <jeton>.dkim.amazonses.com » (ajoutez un des jetons dans « Sélecteurs DKIM » pour le vérifier ici).',
      'SPF : « include:amazonses.com » (ou configurez un domaine MAIL FROM personnalisé dans SES).',
      'Plaintes et rebonds : créez un topic SNS, abonnez-y l’URL de webhook « Amazon SES » ci-dessous (HTTPS), puis activez les notifications « Complaint » et « Bounce » de l’identité.',
    ],
  },
  google: {
    name: 'Gmail / Google Workspace',
    steps: [
      'Console d’administration Google → Applications → Google Workspace → Gmail → « Authentifier les e-mails ».',
      'Choisissez le domaine → « Générer un nouvel enregistrement » (sélecteur « google »), publiez le TXT « google._domainkey » puis cliquez sur « Démarrer l’authentification ».',
      'SPF : « v=spf1 include:_spf.google.com ~all ».',
      'Une adresse @gmail.com gratuite ne peut pas être authentifiée : utilisez une adresse de votre propre domaine.',
    ],
  },
  ovh: {
    name: 'OVHcloud',
    steps: [
      'Espace client OVHcloud → Web Cloud → Noms de domaine → votre domaine → onglet « Zone DNS » → « Ajouter une entrée ».',
      'SPF : entrée TXT (OVH propose un SPF prérempli « include:mx.ovh.com » pour ses offres email).',
      'DKIM : pour MX Plan / Email Pro, activez-le dans Web Cloud → Emails → votre domaine → onglet « DKIM » (OVH crée les CNAME ovhmo…._domainkey).',
      'DMARC : entrée TXT sur « _dmarc » (l’assistant DMARC d’OVH peut la générer).',
    ],
  },
  postmark: {
    name: 'Postmark',
    steps: [
      'Postmark → Sender Signatures → Domains → « Add Domain ».',
      'Publiez le TXT DKIM « <date>pm._domainkey » et le CNAME Return-Path « pm-bounces » → « pm.mtasv.net » (ajoutez « <date>pm » dans « Sélecteurs DKIM »).',
      'SPF : « include:spf.mtasv.net » si vous n’utilisez pas de Return-Path personnalisé.',
    ],
  },
};

function StatusIcon({ status }: { status: DnsRecordCheck['status'] }) {
  if (status === 'ok') return <CircleCheck size={20} className="shrink-0 text-emerald-500" />;
  if (status === 'warning') return <TriangleAlert size={20} className="shrink-0 text-amber-500" />;
  return <CircleX size={20} className="shrink-0 text-rose-500" />;
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] font-semibold tracking-wide text-slate-500 uppercase">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-slate-800 ring-1 ring-slate-200" title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(value)) toast.success('Copié');
        }}
        className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-800"
        title="Copier"
      >
        <Copy size={14} />
      </button>
    </div>
  );
}

function RecordRow({ r }: { r: DnsRecordCheck }) {
  const k = KIND_LABEL[r.kind];
  return (
    <li className="flex gap-3 py-4 first:pt-0 last:pb-0">
      <StatusIcon status={r.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-slate-900">{k.title}</p>
          <Badge tone={r.status === 'ok' ? 'green' : r.status === 'warning' ? 'amber' : 'red'}>{r.status === 'ok' ? 'OK' : r.status === 'warning' ? 'À améliorer' : 'Manquant'}</Badge>
          <span className="text-xs text-slate-400">{k.what}</span>
        </div>
        <p className="mt-1 text-sm text-slate-600">{r.message}</p>
        {r.found.length > 0 && (
          <ul className="mt-2 space-y-1">
            {r.found.map((f) => (
              <li key={f} className="truncate rounded bg-slate-50 px-2 py-1 font-mono text-xs text-slate-600" title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}
        {r.recommended && r.status !== 'ok' && (
          <div className="mt-3 space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-semibold text-slate-700">{r.status === 'missing' ? 'Enregistrement à ajouter' : 'Enregistrement recommandé'}</p>
            <CopyValue label="Type" value={r.recommended.type} />
            <CopyValue label="Hôte" value={r.recommended.host} />
            <CopyValue label="Valeur" value={r.recommended.value} />
          </div>
        )}
      </div>
    </li>
  );
}

export function DomainCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const senderDomain = settings.sender_email.split('@')[1]?.toLowerCase() ?? '';
  const [domain, setDomain] = useState('');
  const [selectors, setSelectors] = useState(settings.dkim_selectors ?? '');
  const [result, setResult] = useState<DnsCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState<ProviderId | ''>('');
  const [helpOpen, setHelpOpen] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      if (selectors.trim() !== (settings.dkim_selectors ?? '')) onSettings(await api.saveSettings({ dkim_selectors: selectors }));
      const r = await api.dnsCheck({ domain: domain.trim() || undefined });
      setResult(r);
      if (!guide && r.provider) setGuide(r.provider);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (senderDomain) void run();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const checked = result?.domain ?? (domain.trim() || senderDomain);
  const free = FREE_DOMAINS.includes(checked);
  const okCount = result?.records.filter((r) => r.status === 'ok').length ?? 0;
  const provider = guide && guide !== 'other' ? PROVIDERS[guide] : null;

  return (
    <Card>
      <CardHeader
        icon={Globe}
        title="Domaine d’envoi"
        description="SPF, DKIM et DMARC prouvent que vos emails viennent bien de vous : sans eux, Gmail et Yahoo les classent en spam."
        actions={
          result ? (
            <Badge tone={result.ok ? 'green' : 'amber'} dot>
              {okCount}/{result.records.length} vérifiés
            </Badge>
          ) : undefined
        }
      />
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
        <Field label="Domaine vérifié" hint={senderDomain ? `Par défaut : le domaine de l’expéditeur (${senderDomain}).` : 'Renseignez l’email de l’expéditeur ci-dessus, ou saisissez un domaine.'}>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={senderDomain || 'mon-entreprise.fr'} />
        </Field>
        <Field label="Sélecteurs DKIM supplémentaires" hint="Séparés par des virgules (ex. brevo1, mg). Les sélecteurs courants sont toujours testés.">
          <Input value={selectors} onChange={(e) => setSelectors(e.target.value)} placeholder="ex. s1, brevo1" />
        </Field>
        <Button variant="secondary" icon={RefreshCw} onClick={run} loading={busy} disabled={!senderDomain && !domain.trim()} className="md:mb-5">
          {result ? 'Revérifier' : 'Vérifier'}
        </Button>
      </div>

      {free && (
        <p className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            <strong>{checked}</strong> est un domaine de messagerie gratuite : vous ne pouvez pas y ajouter de SPF/DKIM, et envoyer des newsletters avec une adresse @{checked}{' '}
            via un autre serveur échoue au contrôle DMARC. Utilisez une adresse de votre propre domaine.
          </span>
        </p>
      )}
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}

      {result && (
        <>
          <p className="mt-4 text-xs text-slate-500">
            Résultat pour <strong className="text-slate-700">{result.domain}</strong> · {fmtDateTime(result.checked_at)} · sélecteurs DKIM testés : {result.selectors.join(', ')}
          </p>
          <ul className="mt-4 divide-y divide-slate-100">
            {result.records.map((r) => (
              <RecordRow key={r.kind} r={r} />
            ))}
          </ul>
        </>
      )}

      <div className="mt-5 rounded-xl border border-slate-200">
        <button type="button" onClick={() => setHelpOpen((o) => !o)} aria-expanded={helpOpen} className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-slate-800 hover:text-slate-950">
          <ChevronRight size={15} className={cx('text-slate-400 transition-transform', helpOpen && 'rotate-90')} />
          Comment configurer mon domaine ?
        </button>
        {helpOpen && (
        <div className="px-4 pb-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
          <Select value={guide} onChange={(e) => setGuide(e.target.value as ProviderId | '')} className="sm:w-64">
            <option value="">Étapes générales</option>
            {(Object.keys(PROVIDERS) as (keyof typeof PROVIDERS)[]).map((k) => (
              <option key={k} value={k}>
                {PROVIDERS[k].name}
                {result?.provider === k ? ' (détecté)' : ''}
              </option>
            ))}
          </Select>
        </div>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-slate-600">
          {provider ? (
            provider.steps.map((s, i) => <li key={i}>{s}</li>)
          ) : (
            <>
              <li>Connectez-vous à l’interface DNS de votre registrar ou hébergeur (OVHcloud, Gandi, Cloudflare, IONOS, o2switch…).</li>
              <li>Activez l’authentification du domaine chez votre fournisseur d’envoi : il vous donne l’enregistrement DKIM (et parfois SPF) à publier.</li>
              <li>Ajoutez ou corrigez les enregistrements signalés ci-dessus (« Hôte @ » = le domaine lui-même). Un seul enregistrement SPF par domaine.</li>
              <li>Commencez DMARC par « p=none », puis passez à « p=quarantine » quand SPF et DKIM sont validés.</li>
              <li>Attendez la propagation (quelques minutes, jusqu’à 48 h) puis cliquez sur « Revérifier ».</li>
            </>
          )}
        </ol>
        </div>
        )}
      </div>
    </Card>
  );
}

const HOOK_PROVIDERS: { id: string; name: string; hint: string }[] = [
  { id: 'ses', name: 'Amazon SES (SNS)', hint: 'Créez un abonnement HTTPS du topic SNS vers cette URL : la confirmation d’abonnement est faite automatiquement. Activez les notifications « Complaint » et « Bounce » de votre identité SES.' },
  { id: 'postmark', name: 'Postmark', hint: 'Servers → votre serveur → Webhooks → « Add webhook » : cochez « Bounce » et « Spam complaint ».' },
  { id: 'mailgun', name: 'Mailgun', hint: 'Send → Webhooks : ajoutez l’URL pour les événements « Permanent failure » et « Spam complaints ».' },
  { id: 'brevo', name: 'Brevo', hint: 'Transactionnel → Paramètres → Webhook : événements « Hard bounce » et « Plainte / spam ».' },
  { id: 'generic', name: 'Format générique (JSON)', hint: 'POST {"type": "complaint" | "bounce", "email": "…", "message_id": "…"} (ou un tableau d’objets).' },
];

export function WebhookCard({ settings, onSettings }: { settings: Settings; onSettings: (s: Settings) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [provider, setProvider] = useState('ses');
  const [busy, setBusy] = useState(false);
  const p = HOOK_PROVIDERS.find((x) => x.id === provider)!;
  const url = settings.webhook_secret ? `${settings.webhook_base_url ?? `${window.location.origin}/api/webhooks/email`}/${provider}/${settings.webhook_secret}` : '';

  const rotate = async () => {
    const ok = await confirm({
      title: 'Régénérer l’URL secrète ?',
      message: 'L’ancienne URL cessera de fonctionner immédiatement : mettez à jour la configuration chez votre fournisseur.',
      confirmLabel: 'Régénérer',
    });
    if (!ok) return;
    setBusy(true);
    try {
      onSettings(await api.rotateWebhookSecret());
      toast.success('Nouvelle URL générée');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={Webhook}
        title="Plaintes et rebonds (webhook)"
        description="Votre fournisseur signale les plaintes pour spam et les adresses invalides : le contact est aussitôt désinscrit ou exclu. Au-delà de 0,3 % de plaintes sur les 1 000 derniers envois, l’envoi se met en pause."
      />
      <div className="grid gap-3 md:grid-cols-[240px_1fr]">
        <Field label="Fournisseur">
          <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {HOOK_PROVIDERS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="URL à configurer" hint={p.hint}>
          <div className="flex gap-2">
            <Input readOnly value={url} className="flex-1 font-mono text-xs" icon={KeyRound} onFocus={(e) => e.target.select()} />
            <Button
              variant="secondary"
              icon={Copy}
              onClick={async () => {
                if (await copyText(url)) toast.success('URL copiée');
              }}
            >
              Copier
            </Button>
          </div>
        </Field>
      </div>
      <div className={cx('mt-3 flex justify-end')}>
        <Button size="sm" variant="ghost" icon={RotateCw} onClick={rotate} loading={busy}>
          Régénérer l’URL secrète
        </Button>
      </div>
    </Card>
  );
}

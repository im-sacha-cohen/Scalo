// Settings → Paiements: the account's own Stripe keys (stored encrypted, never shown again) and its webhook.
import { useState, type FormEvent } from 'react';
import { CircleCheck, Copy, CreditCard, KeyRound, PlugZap, TriangleAlert, Wallet, Webhook } from 'lucide-react';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageLoader, Toggle } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { copyText, useLoad } from '../../lib/hooks';
import { paymentsApi } from '../../lib/payments-api';

export function StripeSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data: s, setData, error, loading, reload } = useLoad(() => paymentsApi.settings(), []);
  const [secret, setSecret] = useState('');
  const [publishable, setPublishable] = useState<string | null>(null);
  const [webhookSecret, setWebhookSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [savingSepa, setSavingSepa] = useState(false);

  if (loading && !s) return <PageLoader />;
  if (error && !s) return <ErrorState message={error} onRetry={reload} />;
  if (!s) return null;
  const pk = publishable ?? s.publishable_key ?? '';
  const dirty = !!secret.trim() || !!webhookSecret.trim() || pk !== (s.publishable_key ?? '');

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const next = await paymentsApi.saveSettings({
        ...(secret.trim() ? { secret_key: secret.trim() } : {}),
        ...(pk !== (s.publishable_key ?? '') ? { publishable_key: pk.trim() || null } : {}),
        ...(webhookSecret.trim() ? { webhook_secret: webhookSecret.trim() } : {}),
      });
      setData(next);
      setSecret('');
      setWebhookSecret('');
      setPublishable(null);
      toast.success('Clés Stripe enregistrées');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await paymentsApi.testConnection();
      setData(r.settings);
      toast.success(`Connexion réussie${r.settings.account_name ? ` : ${r.settings.account_name}` : ''}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };
  const disconnect = async () => {
    const ok = await confirm({
      title: 'Déconnecter Stripe ?',
      message: 'Vos clés sont supprimées : les blocs « Paiement » de vos tunnels afficheront « offre indisponible » et les webhooks ne seront plus traités. Vos commandes sont conservées.',
      confirmLabel: 'Déconnecter',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      setData(await paymentsApi.disconnect());
      toast.success('Stripe déconnecté');
    } catch (err) {
      toast.error(err);
    }
  };
  const toggleSepa = async (on: boolean) => {
    setSavingSepa(true);
    try {
      setData(await paymentsApi.saveSettings({ sepa_debit: on }));
      toast.success(on ? 'Prélèvement SEPA proposé aux acheteurs' : 'Prélèvement SEPA retiré');
    } catch (err) {
      toast.error(err);
    } finally {
      setSavingSepa(false);
    }
  };
  const copy = async () => {
    if (await copyText(s.webhook_url)) toast.success('URL copiée');
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={CreditCard}
          title="Stripe"
          description="Encaissez sur votre propre compte Stripe : les paiements arrivent directement chez vous, Scalo ne prend aucune commission."
          actions={
            s.connected ? (
              <Badge tone={s.mode === 'live' ? 'green' : 'amber'} dot>
                {s.mode === 'live' ? 'Connecté · mode réel' : 'Connecté · mode test'}
              </Badge>
            ) : (
              <Badge dot>Non connecté</Badge>
            )
          }
        />
        <form onSubmit={save} className="space-y-4">
          <p className="text-sm text-slate-600">
            Copiez vos clés depuis <span className="font-mono text-[13px]">dashboard.stripe.com</span> → Développeurs → Clés API. Elles sont chiffrées sur le serveur et ne sont plus jamais affichées. Le mode (test ou réel) est détecté
            d’après leur préfixe.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Clé secrète" hint={s.connected ? 'Laissez vide pour conserver la clé actuelle.' : 'Commence par sk_test_ ou sk_live_ (ou une clé restreinte rk_…).'}>
              <Input
                type="password"
                autoComplete="off"
                icon={KeyRound}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={s.connected ? `${s.mode === 'live' ? 'sk_live' : 'sk_test'}_…${s.secret_key_hint ?? ''}` : 'sk_live_…'}
              />
            </Field>
            <Field label="Clé publique" hint="Commence par pk_test_ ou pk_live_. Indispensable : le formulaire de paiement s’affiche directement dans vos pages.">
              <Input autoComplete="off" value={pk} onChange={(e) => setPublishable(e.target.value)} placeholder="pk_live_…" />
            </Field>
          </div>
          {s.connected && !s.publishable_key && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" /> Ajoutez la clé publique : sans elle, vos acheteurs ne peuvent pas payer sur vos pages.
            </p>
          )}
          {s.connected && s.verified_at && (
            <p className="flex items-center gap-2 text-sm text-emerald-700">
              <CircleCheck size={15} /> Connexion vérifiée le {fmtDateTime(s.verified_at)}
              {s.account_name ? ` — ${s.account_name}` : ''}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={saving} disabled={!dirty}>
              Enregistrer
            </Button>
            <Button variant="secondary" icon={PlugZap} onClick={test} loading={testing} disabled={!s.connected || !!secret.trim()}>
              Tester la connexion
            </Button>
            {s.connected && (
              <Button variant="ghost" className="ml-auto text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={disconnect}>
                Déconnecter
              </Button>
            )}
          </div>

          <div className="border-t border-slate-100 pt-5">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Wallet size={15} className="text-slate-400" /> Moyens de paiement
            </h4>
            <p className="mt-1 text-sm text-slate-600">
              L’acheteur paie sans quitter votre page : carte bancaire, Apple Pay et Google Pay (selon son appareil), validation 3-D Secure comprise. Activez Apple Pay / Google Pay dans Stripe → Paramètres → Moyens de paiement ; vos domaines
              sont déclarés automatiquement.
            </p>
            <div className="mt-3">
              <Toggle
                checked={s.sepa_debit}
                onChange={toggleSepa}
                disabled={!s.connected || savingSepa}
                label="Prélèvement SEPA"
                description="Pour les offres en euros. Activez-le d’abord dans votre tableau de bord Stripe. L’accès est donné quand la banque confirme le prélèvement (quelques jours)."
              />
            </div>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <Webhook size={15} className="text-slate-400" /> Webhook
              {s.webhook_secret_set ? <Badge tone="green">Secret enregistré (…{s.webhook_secret_hint})</Badge> : <Badge tone="amber">À configurer</Badge>}
            </h4>
            <p className="mt-1 text-sm text-slate-600">
              Le webhook confirme les paiements même si l’acheteur ferme la page, et synchronise les remboursements et les abonnements. Dans Stripe → Développeurs → Webhooks, ajoutez un point de terminaison avec cette URL, puis collez son
              « secret de signature ».
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-[1.4fr_1fr]">
              <Field label="URL du point de terminaison">
                <div className="flex gap-2">
                  <Input readOnly value={s.webhook_url} className="flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
                  <Button variant="secondary" icon={Copy} onClick={copy}>
                    Copier
                  </Button>
                </div>
              </Field>
              <Field label="Secret de signature" hint={s.webhook_secret_set ? 'Laissez vide pour conserver le secret actuel.' : 'Commence par whsec_.'}>
                <Input type="password" autoComplete="off" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} placeholder={s.webhook_secret_set ? `whsec_…${s.webhook_secret_hint ?? ''}` : 'whsec_…'} />
              </Field>
            </div>
            <details className="mt-3 text-sm text-slate-600">
              <summary className="cursor-pointer font-medium text-slate-700">Événements à sélectionner ({s.webhook_events.length})</summary>
              <ul className="mt-2 grid gap-x-6 gap-y-1 font-mono text-xs sm:grid-cols-2">
                {s.webhook_events.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          </div>
        </form>
      </Card>
    </div>
  );
}

// Paramètres → « Données et compte » : téléchargement des données (RGPD), suppression de toutes les données,
// suppression du compte. Réservé au propriétaire du compte (l’API répond 403 à un membre d’équipe).
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Archive, CircleAlert, Download, Eraser, Lock, ShieldAlert, Trash2, TriangleAlert, UserX } from 'lucide-react';
import type { AccountDataSummary } from '@scalo/shared';
import { accountApi, ACCOUNT_DELETED_FLAG } from '../../lib/account-api';
import { downloadBlob } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useEdition } from '../../lib/edition';
import { fmtNumber } from '../../lib/format';
import { Button, Card, CardHeader, Field, Input, Skeleton } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';

type Mode = 'reset' | 'delete';
type Counts = AccountDataSummary['counts'];

const KEPT = 'vos réglages d’expéditeur, d’adresse et d’envoi (SMTP, cadence), la connexion Stripe, la clé IA, les applications connectées et Développeurs, le nom et l’adresse de l’espace membres et du programme d’affiliation, votre équipe';

function fmtBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
}

/** Rows of the recap (the zero ones are listed apart, in one line). */
function recap(c: Counts, mode: Mode): [string, number | string][] {
  const rows: [string, number | string][] = [
    ['Contacts', c.contacts],
    ['Tags', c.tags],
    ['Champs personnalisés', c.custom_fields],
    ['Segments', c.segments],
    ['Tunnels', c.funnels],
    ['Étapes de tunnel', c.steps],
    ['Domaines personnalisés', c.domains],
    ['Newsletters', c.broadcasts],
    ['Campagnes', c.campaigns],
    ['Emails en attente d’envoi', c.queued_emails],
    ['Automatisations', c.automations],
    ['Exécutions d’automatisation en cours', c.active_runs],
    ['Imports', c.imports],
    ['Produits', c.products],
    ['Commandes', c.orders],
    ['Formations', c.courses],
    ['Leçons', c.lessons],
    ['Accès et progressions d’élèves', c.students],
    ['Affiliés', c.affiliates],
    ['Images de la médiathèque', c.media_files],
    ['Fichiers de leçon', c.lesson_files],
    ['Espace disque libéré', fmtBytes(c.files_bytes)],
  ];
  if (mode === 'delete') rows.push(['Applications OAuth (Développeurs)', c.oauth_apps], ['Membres d’équipe', c.team_members], ['Invitations en attente', c.invitations]);
  return rows;
}

export function AccountDataSection() {
  const toast = useToast();
  const { role } = useEdition();
  const [exporting, setExporting] = useState(false);
  const [mode, setMode] = useState<Mode | null>(null);

  if (role !== 'owner') {
    return (
      <Card>
        <CardHeader icon={Lock} title="Données et compte" description="Réservé au propriétaire du compte." />
        <p className="text-sm text-slate-600">L’export des données, leur suppression et la suppression du compte ne peuvent être faits que par le propriétaire du compte.</p>
      </Card>
    );
  }

  const exportData = async () => {
    setExporting(true);
    try {
      const { blob, name } = await accountApi.exportZip();
      downloadBlob(blob, name);
      toast.success('Archive téléchargée');
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader icon={Archive} title="Télécharger mes données" description="Une archive ZIP de tout votre compte, lisible par n’importe quel outil (portabilité RGPD)." />
        <p className="text-sm text-slate-600">
          Contacts (avec leurs tags, champs personnalisés et historique, en JSON et en CSV), tunnels et pages, newsletters et campagnes, automatisations, segments, produits et commandes, formations et
          progression des élèves, affiliation, médiathèque et réglages. <strong className="font-semibold text-slate-800">Aucun secret n’y figure</strong> : ni mot de passe, ni clé Stripe ou IA, ni secret de webhook.
        </p>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" icon={Download} onClick={exportData} loading={exporting}>
            Télécharger l’archive (.zip)
          </Button>
        </div>
      </Card>

      <section aria-labelledby="danger-zone" className="overflow-hidden rounded-2xl border border-rose-200 bg-white">
        <div className="flex items-center gap-2.5 border-b border-rose-100 bg-rose-50/70 px-5 py-3">
          <ShieldAlert size={17} className="text-rose-600" />
          <h3 id="danger-zone" className="font-display text-base font-bold tracking-[-0.01em] text-rose-900">
            Zone dangereuse
          </h3>
          <span className="ml-auto text-xs font-medium text-rose-700">Irréversible</span>
        </div>
        <div className="divide-y divide-rose-100">
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Supprimer toutes les données</p>
              <p className="mt-1 text-sm text-slate-600">
                Contacts, tunnels, emails, automatisations, ventes, formations, affiliation, fichiers et statistiques. Le compte reste ouvert, vide, comme juste après l’inscription.
              </p>
              <p className="mt-1 text-xs text-slate-500">Conservés : {KEPT}.</p>
            </div>
            <Button variant="secondary" icon={Eraser} className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800 sm:mt-0.5" onClick={() => setMode('reset')}>
              Supprimer les données…
            </Button>
          </div>
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">Supprimer le compte</p>
              <p className="mt-1 text-sm text-slate-600">
                Toutes les données, les réglages, les applications connectées, l’équipe et vos accès. Vos pages publiques, espaces membres et affiliés et domaines personnalisés cesseront de répondre.
              </p>
            </div>
            <Button variant="danger" icon={UserX} className="sm:mt-0.5" onClick={() => setMode('delete')}>
              Supprimer le compte…
            </Button>
          </div>
        </div>
      </section>

      <DeletionModal mode={mode} onClose={() => setMode(null)} onExport={exportData} exporting={exporting} />
    </div>
  );
}

function DeletionModal({ mode, onClose, onExport, exporting }: { mode: Mode | null; onClose: () => void; onExport: () => void; exporting: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [summary, setSummary] = useState<AccountDataSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mode) return;
    setSummary(null);
    setLoadError(null);
    setPassword('');
    setConfirm('');
    setError(null);
    let alive = true;
    accountApi
      .summary()
      .then((s) => alive && setSummary(s))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [mode]);

  const matches = !!summary && confirm.trim().toLowerCase() === summary.email.toLowerCase();
  const isDelete = mode === 'delete';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!mode || !matches || !password) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'reset') {
        await accountApi.resetData({ password, confirm: confirm.trim() });
        toast.success('Toutes les données du compte ont été supprimées');
        onClose();
        navigate('/dashboard');
      } else {
        await accountApi.deleteAccount({ password, confirm: confirm.trim() });
        try {
          sessionStorage.setItem(ACCOUNT_DELETED_FLAG, '1');
        } catch {
          /* storage unavailable: no message on the landing page */
        }
        // session forgotten, then a full reload of the landing page: no screen of the app keeps the deleted account
        logout();
        window.location.replace('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const c = summary?.counts;
  return (
    <Modal
      open={!!mode}
      onClose={busy ? () => undefined : onClose}
      size="lg"
      title={isDelete ? 'Supprimer définitivement le compte ?' : 'Supprimer toutes les données ?'}
      description={isDelete ? 'Le compte, ses données et ses réglages seront effacés. Cette action est irréversible.' : 'Le compte reste ouvert mais sera vide. Cette action est irréversible.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Annuler
          </Button>
          <Button type="submit" form="account-deletion-form" variant="danger" icon={isDelete ? UserX : Trash2} loading={busy} disabled={!matches || !password}>
            {isDelete ? 'Supprimer le compte' : 'Supprimer toutes les données'}
          </Button>
        </>
      }
    >
      {loadError ? (
        <p className="flex items-center gap-2 text-sm text-rose-700">
          <CircleAlert size={16} /> {loadError}
        </p>
      ) : !summary || !c ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <form id="account-deletion-form" onSubmit={submit} className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-semibold text-slate-800">Ce qui sera supprimé</p>
            {(() => {
              const rows = recap(c, mode!);
              const some = rows.filter(([, v]) => v !== 0 && v !== '0 o');
              const none = rows.filter(([, v]) => v === 0).map(([l]) => l);
              return (
                <>
                  {some.length > 0 ? (
                    <dl className="grid gap-x-6 gap-y-1 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
                      {some.map(([label, v]) => (
                        <div key={label} className="flex items-baseline justify-between gap-3 py-0.5">
                          <dt className="min-w-0">{label}</dt>
                          <dd className="shrink-0 font-semibold tabular-nums text-ink">{typeof v === 'number' ? fmtNumber(v) : v}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">Le compte ne contient aucune donnée.</p>
                  )}
                  {c.contacts > 0 && <p className="mt-1.5 text-xs text-slate-500">Les contacts sont supprimés avec leurs tags, champs personnalisés, historique et progression.</p>}
                  {none.length > 0 && <p className="mt-1.5 text-xs text-slate-400">Aucun élément : {none.join(', ').toLowerCase()}.</p>}
                </>
              );
            })()}
            {!isDelete && <p className="mt-2 text-xs text-slate-500">Conservés : {KEPT}.</p>}
          </div>

          <ul className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-sm text-amber-900">
            <li className="flex gap-2">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <span>
                <strong>Stripe :</strong> les abonnements et paiements de vos clients restent dans votre compte Stripe ; Scalo ne les annule pas.
                {summary.active_subscriptions > 0 && ` ${fmtNumber(summary.active_subscriptions)} abonnement${summary.active_subscriptions > 1 ? 's' : ''} actif${summary.active_subscriptions > 1 ? 's' : ''} continuera${summary.active_subscriptions > 1 ? 'ont' : ''} d’être prélevé${summary.active_subscriptions > 1 ? 's' : ''} : arrêtez-les dans Stripe si nécessaire.`}
              </span>
            </li>
            <li className="flex gap-2">
              <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <span>
                Les automatisations et les campagnes s’arrêtent immédiatement
                {c.queued_emails > 0 ? ` : ${fmtNumber(c.queued_emails)} email${c.queued_emails > 1 ? 's' : ''} en attente ne partir${c.queued_emails > 1 ? 'ont' : 'a'} pas.` : '.'}
              </span>
            </li>
            <li className="flex gap-2">
              <Download size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <span>
                Conseil : <button type="button" onClick={onExport} disabled={exporting} className="font-semibold underline underline-offset-2 hover:text-amber-950 disabled:opacity-60">téléchargez d’abord vos données</button>.
              </span>
            </li>
          </ul>

          <Field label="Votre mot de passe">
            <Input icon={Lock} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-autofocus />
          </Field>
          <Field
            label={
              <>
                Pour confirmer, saisissez l’adresse email du compte : <span className="font-semibold break-all text-ink">{summary.email}</span>
              </>
            }
          >
            <Input type="email" autoComplete="off" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={summary.email} />
          </Field>
          {error && (
            <p role="alert" className="flex items-center gap-2 text-sm font-medium text-rose-700">
              <CircleAlert size={16} /> {error}
            </p>
          )}
        </form>
      )}
    </Modal>
  );
}

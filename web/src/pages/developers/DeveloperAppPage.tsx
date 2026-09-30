// `/developers/:id` — one registered application: credentials, flow tester (authorize URL + curl), settings, deletion.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft, ExternalLink, FlaskConical, KeyRound, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import type { OAuthApp, OAuthScope } from '@scalo/shared';
import { api } from '../../lib/api';
import { useLoad } from '../../lib/hooks';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Card, CardHeader, ErrorState, Field, PageHeader, PageLoader, Select, Toggle, cx } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { AppLogo, CodeBlock, CopyValue } from '../oauth/common';
import { AppForm, TEST_CALLBACK } from './AppForm';
import { ORIGIN } from './Docs';
import { SecretModal } from './SecretModal';

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function s256(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Builds an authorization URL and the matching curl commands. */
function FlowTester({ app }: { app: OAuthApp }) {
  const [redirect, setRedirect] = useState(() => (app.redirect_uris.includes(TEST_CALLBACK) ? TEST_CALLBACK : app.redirect_uris[0]));
  const [scopes, setScopes] = useState<OAuthScope[]>(() => {
    const base: OAuthScope[] = app.scopes.filter((s) => s !== 'offline_access').slice(0, 3);
    return app.scopes.includes('offline_access') ? [...base, 'offline_access'] : base;
  });
  const [state, setState] = useState(() => randomString(12));
  const [usePkce, setUsePkce] = useState(true);
  const [verifier, setVerifier] = useState(() => randomString(32));
  const [challenge, setChallenge] = useState('');
  const pkce = app.type === 'public' || usePkce;

  useEffect(() => {
    let alive = true;
    void s256(verifier).then((c) => alive && setChallenge(c));
    return () => {
      alive = false;
    };
  }, [verifier]);
  useEffect(() => {
    if (!app.redirect_uris.includes(redirect)) setRedirect(app.redirect_uris[0]);
  }, [app.redirect_uris, redirect]);

  const url = useMemo(() => {
    const p = new URLSearchParams({ response_type: 'code', client_id: app.client_id, redirect_uri: redirect, scope: scopes.join(' '), state });
    if (pkce && challenge) {
      p.set('code_challenge', challenge);
      p.set('code_challenge_method', 'S256');
    }
    return `${ORIGIN}/oauth/authorize?${p}`;
  }, [app.client_id, redirect, scopes, state, pkce, challenge]);

  const cmd = (...parts: (string | false)[]) => parts.filter(Boolean).join(' \\\n  ');
  const auth = app.type === 'confidential' && `-u "${app.client_id}:$CLIENT_SECRET"`;
  const pub = app.type === 'public' && `-d client_id=${app.client_id}`;
  const exchange = cmd(
    `curl -X POST ${ORIGIN}/oauth/token`,
    auth,
    '-d grant_type=authorization_code',
    '-d code=$CODE',
    `--data-urlencode redirect_uri=${redirect}`,
    pub,
    pkce && `-d code_verifier=${verifier}`,
  );
  const refresh = cmd(`curl -X POST ${ORIGIN}/oauth/token`, auth, '-d grant_type=refresh_token', pub, '-d refresh_token=$REFRESH_TOKEN');
  const call = cmd(`curl "${ORIGIN}/api/v1/${scopes.includes('contacts:read') ? 'contacts?limit=5' : 'me'}"`, '-H "Authorization: Bearer $ACCESS_TOKEN"');
  const revoke = cmd(`curl -X POST ${ORIGIN}/oauth/revoke`, auth, pub, '-d token=$REFRESH_TOKEN');

  return (
    <Card>
      <CardHeader icon={FlaskConical} title="Tester le flux" description="Construisez une URL d’autorisation, ouvrez-la, puis échangez le code reçu avec curl." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="redirect_uri">
          <Select value={redirect} onChange={(e) => setRedirect(e.target.value)}>
            {app.redirect_uris.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="state" hint="Valeur aléatoire à vérifier au retour (protection CSRF).">
          <div className="flex gap-2">
            <code className="flex h-9 min-w-0 flex-1 items-center truncate rounded-lg border border-slate-200 bg-slate-50 px-3 font-mono text-[13px]">{state}</code>
            <Button variant="secondary" icon={RefreshCw} onClick={() => setState(randomString(12))} aria-label="Nouveau state" />
          </div>
        </Field>
      </div>
      <div className="mt-4">
        <span className="mb-1.5 block text-sm font-medium text-slate-700">scope</span>
        <div className="flex flex-wrap gap-1.5">
          {app.scopes.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScopes((l) => (l.includes(s) ? l.filter((x) => x !== s) : app.scopes.filter((x) => x === s || l.includes(x))))}
              className={cx('h-7 rounded-md px-2.5 font-mono text-xs transition-colors', scopes.includes(s) ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Toggle
          checked={pkce}
          disabled={app.type === 'public'}
          onChange={setUsePkce}
          label="PKCE (S256)"
          description={app.type === 'public' ? 'Obligatoire pour une application publique.' : 'Recommandé aussi pour une application confidentielle.'}
        />
        {pkce && (
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => setVerifier(randomString(32))}>
            Nouveau code_verifier
          </Button>
        )}
      </div>
      {pkce && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-xs text-slate-500">code_verifier (gardé par votre application, envoyé à l’échange du code)</p>
          <CopyValue value={verifier} />
        </div>
      )}
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium text-slate-700">URL d’autorisation</p>
        <CodeBlock code={url} />
        <div className="mt-2 flex justify-end">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={cx('inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand-600 px-3 text-sm font-medium text-white hover:bg-brand-700', !scopes.length && 'pointer-events-none opacity-50')}
          >
            Ouvrir dans un nouvel onglet <ExternalLink size={14} />
          </a>
        </div>
        {!scopes.length && <p className="text-xs text-rose-600">Choisissez au moins un scope.</p>}
      </div>
      <div className="mt-5 space-y-4">
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Échanger le code (dans les 60 s)</p>
          <CodeBlock code={exchange} />
        </div>
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Appeler l’API</p>
          <CodeBlock code={call} />
        </div>
        {app.scopes.includes('offline_access') && (
          <div>
            <p className="mb-1 text-sm font-medium text-slate-700">Rafraîchir (rotation : conservez le nouveau refresh_token)</p>
            <CodeBlock code={refresh} />
          </div>
        )}
        <div>
          <p className="mb-1 text-sm font-medium text-slate-700">Révoquer</p>
          <CodeBlock code={revoke} />
        </div>
      </div>
    </Card>
  );
}

export function DeveloperAppPage() {
  const { id } = useParams();
  const appId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const { data: app, setData, error, loading, reload } = useLoad(() => api.developerApp(appId), [appId]);
  const [secret, setSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [formKey, setFormKey] = useState(0);

  if (loading && !app) return <PageLoader />;
  if (error && !app) return <ErrorState message={error} onRetry={reload} />;
  if (!app) return null;

  const rotate = async () => {
    const ok = await confirm({
      title: 'Générer un nouveau secret ?',
      message: 'L’ancien client_secret cessera immédiatement de fonctionner : mettez à jour votre serveur juste après.',
      confirmLabel: 'Générer',
    });
    if (!ok) return;
    setRotating(true);
    try {
      const r = await api.rotateDeveloperSecret(app.id);
      const { client_secret, ...rest } = r;
      setData(rest);
      setSecret(client_secret ?? null);
    } catch (e) {
      toast.error(e);
    } finally {
      setRotating(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Supprimer ${app.name} ?`,
      message: `Tous les jetons émis sont révoqués immédiatement${app.authorizations_count ? ` et ${app.authorizations_count} utilisateur(s) perdront la connexion` : ''}. Action irréversible.`,
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await api.deleteDeveloperApp(app.id);
      toast.success('Application supprimée');
      navigate('/developers', { replace: true });
    } catch (e) {
      toast.error(e);
      setDeleting(false);
    }
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/developers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
            <ArrowLeft size={15} /> Développeurs
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <AppLogo name={app.name} url={app.logo_url} size={36} />
            {app.name}
          </span>
        }
        description={`${app.type === 'public' ? 'Application publique' : 'Application confidentielle'} · créée le ${fmtDate(app.created_at)} · ${app.authorizations_count} utilisateur(s) connecté(s)`}
      />
      <div className="max-w-4xl space-y-6">
        <Card>
          <CardHeader icon={KeyRound} title="Identifiants" />
          <div className="space-y-4">
            <div>
              <p className="mb-1 font-mono text-xs text-slate-500">client_id</p>
              <CopyValue value={app.client_id} />
            </div>
            {app.type === 'confidential' ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="mb-1 font-mono text-xs text-slate-500">client_secret</p>
                  <p className="font-mono text-sm text-slate-700">
                    scalo_cs_••••••••{app.secret_hint}
                    {app.secret_rotated_at && <span className="ml-2 font-sans text-xs text-slate-500">renouvelé le {fmtDate(app.secret_rotated_at)}</span>}
                  </p>
                </div>
                <Button variant="secondary" icon={RefreshCw} onClick={rotate} loading={rotating}>
                  Générer un nouveau secret
                </Button>
              </div>
            ) : (
              <p className="text-sm text-slate-500">
                Application publique : pas de secret. <Badge tone="blue">PKCE S256 obligatoire</Badge>
              </p>
            )}
          </div>
        </Card>

        <FlowTester app={app} />

        <Card>
          <CardHeader icon={Settings2} title="Paramètres" description="Retirer un scope s’applique immédiatement aux jetons déjà émis." />
          <AppForm
            key={formKey}
            initial={{ ...app, description: app.description, website: app.website ?? '', logo_url: app.logo_url ?? '' }}
            submitLabel="Enregistrer"
            onSubmit={async (v) => {
              try {
                const updated = await api.updateDeveloperApp(app.id, {
                  name: v.name,
                  description: v.description,
                  website: v.website,
                  logo_url: v.logo_url,
                  redirect_uris: v.redirect_uris,
                  scopes: v.scopes,
                });
                setData(updated);
                setFormKey((k) => k + 1);
                toast.success('Application enregistrée');
              } catch (e) {
                toast.error(e);
              }
            }}
          />
        </Card>

        <Card className="border-rose-200">
          <CardHeader icon={Trash2} title="Supprimer l’application" description="Révoque immédiatement tous les jetons et autorisations accordés à cette application." />
          <div className="flex justify-end">
            <Button variant="danger" icon={Trash2} onClick={remove} loading={deleting}>
              Supprimer
            </Button>
          </div>
        </Card>
      </div>
      <SecretModal title="Nouveau secret" clientId={app.client_id} secret={secret} onClose={() => setSecret(null)} />
    </>
  );
}

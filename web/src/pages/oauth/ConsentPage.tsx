// `/oauth/consent?request=…` — the consent screen of the authorization server (login required, see App.tsx).
// The API validated the request (client, redirect_uri, scopes, PKCE) before sending the browser here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { CircleAlert, ExternalLink, ShieldCheck } from 'lucide-react';
import { OAUTH_SCOPE_INFO, type OAuthConsentRequest } from '@scalo/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, Spinner } from '../../components/ui';
import { Logo } from '../../components/Layout';
import { AppLogo } from './common';

const hostOf = (uri: string) => {
  try {
    const u = new URL(uri);
    return u.host || `${u.protocol}${u.pathname}`;
  } catch {
    return uri;
  }
};

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="mb-6">
        <Logo />
      </div>
      <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-card">{children}</div>
      <p className="mt-6 max-w-md text-center text-xs text-slate-400">
        Vous pouvez retirer l’accès à tout moment dans Paramètres → Applications connectées.
      </p>
    </div>
  );
}

export function ConsentPage() {
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState<OAuthConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const started = useRef(false);
  // defense in depth against clickjacking (the server also sends frame-ancestors 'none' / X-Frame-Options)
  const framed = typeof window !== 'undefined' && window.top !== window.self;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(decision);
    try {
      const { redirect_to } = await api.oauthConsent(requestId, decision);
      window.location.assign(redirect_to);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  useEffect(() => {
    if (started.current || framed) return; // StrictMode runs effects twice; the request is single use
    started.current = true;
    if (!requestId) {
      setError('Lien d’autorisation invalide.');
      return;
    }
    api
      .oauthRequest(requestId)
      .then((r) => {
        setData(r);
        // already authorized with these scopes (and prompt=consent not requested): no need to ask again
        if (r.remembered) void decide('approve');
      })
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId, framed]);

  if (framed) {
    return (
      <Shell>
        <p className="text-sm text-slate-600">Pour votre sécurité, cette page ne peut pas être affichée dans un cadre.</p>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <div className="text-center">
          <CircleAlert size={36} className="mx-auto text-rose-500" />
          <h1 className="mt-4 text-lg font-semibold text-slate-900">Autorisation impossible</h1>
          <p className="mt-2 text-sm text-slate-500">{error}</p>
          <Button variant="secondary" className="mt-6" onClick={() => navigate('/')}>
            Aller au tableau de bord
          </Button>
        </div>
      </Shell>
    );
  }

  if (!data || data.remembered) {
    return (
      <Shell>
        <div className="flex flex-col items-center py-6 text-center">
          <Spinner size={30} />
          <p className="mt-4 text-sm text-slate-500">{data ? `Redirection vers ${data.client.name}…` : 'Chargement…'}</p>
        </div>
      </Shell>
    );
  }

  const c = data.client;
  return (
    <Shell>
      <div className="flex flex-col items-center text-center">
        <AppLogo name={c.name} url={c.logo_url} size={56} />
        <h1 className="mt-4 text-lg font-semibold text-slate-900">
          <span className="text-brand-700">{c.name}</span> souhaite accéder à votre compte
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          Application développée par {c.owner_name}
          {c.website && (
            <>
              {' · '}
              <a href={c.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-medium text-slate-600 hover:text-slate-900">
                {hostOf(c.website)} <ExternalLink size={11} />
              </a>
            </>
          )}
        </p>
        {c.description && <p className="mt-3 text-sm text-slate-600">{c.description}</p>}
      </div>

      <div className="mt-5 flex items-center gap-2.5 rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <span className="text-slate-500">Compte :</span>
        <span className="min-w-0 flex-1 truncate font-medium text-slate-900">{user?.email}</span>
        <button
          type="button"
          className="shrink-0 text-xs font-medium text-brand-600 hover:text-brand-700"
          onClick={() => {
            logout();
            navigate(`/login?next=${encodeURIComponent(`/oauth/consent?request=${requestId}`)}`, { replace: true });
          }}
        >
          Changer de compte
        </button>
      </div>

      <p className="mt-5 text-sm font-medium text-slate-900">Cette application pourra :</p>
      <ul className="mt-2 space-y-2.5">
        {data.scopes.map((s) => (
          <li key={s} className="flex gap-2.5">
            <ShieldCheck size={17} className="mt-0.5 shrink-0 text-brand-600" />
            <div>
              <p className="text-sm font-medium text-slate-800">{OAUTH_SCOPE_INFO[s]?.label ?? s}</p>
              <p className="text-xs text-slate-500">{OAUTH_SCOPE_INFO[s]?.description}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="mt-5 text-xs text-slate-500">
        En autorisant, vous serez redirigé vers <strong className="font-medium text-slate-700">{hostOf(data.redirect_uri)}</strong>. Autorisez uniquement les
        applications en qui vous avez confiance.
      </p>
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button variant="secondary" size="lg" onClick={() => decide('deny')} loading={busy === 'deny'} disabled={!!busy}>
          Refuser
        </Button>
        <Button size="lg" onClick={() => decide('approve')} loading={busy === 'approve'} disabled={!!busy}>
          Autoriser
        </Button>
      </div>
    </Shell>
  );
}

// `/oauth/test-callback` — DEV ONLY (registered in App.tsx when import.meta.env.DEV): a redirect URI to try the
// authorization flow without writing a client. Shows what the authorization server sent back.
import { useSearchParams } from 'react-router';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { Logo } from '../../components/Layout';
import { CopyValue } from './common';

export function TestCallbackPage() {
  const [params] = useSearchParams();
  const code = params.get('code');
  const error = params.get('error');
  const rows: [string, string | null][] = [
    ['code', code],
    ['state', params.get('state')],
    ['iss', params.get('iss')],
    ['error', error],
    ['error_description', params.get('error_description')],
  ];
  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-slate-50 px-4 py-10">
      <div className="mb-6">
        <Logo />
      </div>
      <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-7 shadow-card">
        <div className="flex items-center gap-2.5">
          {error ? <CircleAlert size={22} className="text-rose-500" /> : <CircleCheck size={22} className="text-emerald-600" />}
          <h1 className="text-lg font-semibold text-slate-900">{error ? 'Autorisation refusée ou en erreur' : 'Code d’autorisation reçu'}</h1>
        </div>
        <p className="mt-1 text-xs text-slate-500">Page de test (développement uniquement) : ce que votre application recevrait sur son URL de redirection.</p>
        <dl className="mt-5 space-y-3">
          {rows
            .filter(([, v]) => v !== null)
            .map(([k, v]) => (
              <div key={k}>
                <dt className="mb-1 font-mono text-xs text-slate-500">{k}</dt>
                <dd>
                  <CopyValue value={v!} />
                </dd>
              </div>
            ))}
        </dl>
        {code && (
          <p className="mt-5 text-xs text-slate-500">
            Le code est valable <strong>60 secondes</strong> et ne peut être échangé qu’une fois (<code className="font-mono">POST /oauth/token</code>).
          </p>
        )}
      </div>
    </div>
  );
}

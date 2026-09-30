import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CircleCheck, Lock, Mail, User as UserIcon } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { Button, Field, Input } from '../components/ui';
import { Logo } from '../components/Layout';

/** Same-origin relative path only (open-redirect safe). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : null);
/** Keeps `?next=` when switching between login and register (e.g. coming from an OAuth consent screen). */
const withNext = (path: string, next: string | null) => (next ? `${path}?next=${encodeURIComponent(next)}` : path);

/** Shown above the form when the user comes from a third-party application's authorization request. */
function OAuthNotice({ next }: { next: string | null }) {
  if (!next?.startsWith('/oauth/consent')) return null;
  return (
    <div className="mb-5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm text-brand-800">
      Une application demande l’accès à votre compte : connectez-vous pour continuer.
    </div>
  );
}

function AuthShell({ title, subtitle, children, footer }: { title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex min-h-full">
      <div className="relative hidden w-[46%] max-w-[640px] flex-col justify-between overflow-hidden bg-ink p-10 text-white lg:flex">
        {/* Brand motif: the logo's stepped pills, oversized and cropped. Flat fills only (see brand/BRAND.md). */}
        <svg className="pointer-events-none absolute -top-8 -right-20 w-[300px] opacity-90" viewBox="12 12.5 40 39" aria-hidden="true">
          <rect x="12" y="38.5" width="24" height="13" rx="6.5" fill="#2A1F8C" />
          <rect x="20" y="25.5" width="24" height="13" rx="6.5" fill="#5B4BFF" />
          <rect x="28" y="12.5" width="24" height="13" rx="6.5" fill="#C6F432" />
        </svg>
        <div className="relative">
          <Logo dark />
        </div>
        <div className="relative">
          <h2 className="max-w-md text-4xl leading-tight font-extrabold">
            Tout votre business en ligne, <span className="text-lime-400">au même endroit.</span>
          </h2>
          <p className="mt-4 max-w-md text-slate-300">Créez des tunnels de vente, capturez des leads et automatisez vos emails — sans une ligne de code.</p>
          <ul className="mt-8 space-y-3 text-sm text-slate-200">
            {[
              'Éditeur de pages par glisser-déposer',
              'Newsletters et campagnes automatiques',
              'CRM avec tags et historique complet',
            ].map((t) => (
              <li key={t} className="flex items-center gap-3">
                <CircleCheck size={18} className="text-emerald-400" /> {t}
              </li>
            ))}
          </ul>
          <div className="mt-10 grid max-w-md grid-cols-3 gap-3">
            {[
              ['12,4 %', 'Taux d’optin'],
              ['48 %', 'Ouverture'],
              ['2 min', 'Pour publier'],
            ].map(([v, l]) => (
              <div key={l} className="rounded-xl border border-white/10 bg-white/5 p-3 backdrop-blur">
                <p className="text-xl font-bold">{v}</p>
                <p className="text-xs text-slate-400">{l}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-xs text-slate-500">© {new Date().getFullYear()} Scalo</p>
      </div>

      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden">
            <Logo />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-6 text-center text-sm text-slate-500">{footer}</div>
        </div>
      </div>
    </div>
  );
}

function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{error}</div>;
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate(next ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Bon retour 👋"
      subtitle="Connectez-vous à votre espace."
      footer={
        <>
          Pas encore de compte ?{' '}
          <Link to={withNext('/register', next)} className="font-semibold text-brand-600 hover:text-brand-700">
            Créer un compte
          </Link>
        </>
      }
    >
      <OAuthNotice next={next} />
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox error={error} />
        <Field label="Email">
          <Input icon={Mail} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" autoFocus />
        </Field>
        <Field label="Mot de passe">
          <Input icon={Lock} type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Se connecter
        </Button>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // self-hosted instances can close public sign-ups (ALLOW_SIGNUPS=false): say so before the form is filled in
  const [closed, setClosed] = useState(false);
  useEffect(() => {
    fetch('/api/auth/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((c: { signups?: boolean } | null) => setClosed(c?.signups === false))
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await register(name.trim(), email.trim(), password);
      navigate(next ?? '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell
      title="Créez votre compte"
      subtitle="Gratuit, sans carte bancaire. Lancez votre premier tunnel en 2 minutes."
      footer={
        <>
          Déjà inscrit ?{' '}
          <Link to={withNext('/login', next)} className="font-semibold text-brand-600 hover:text-brand-700">
            Se connecter
          </Link>
        </>
      }
    >
      <OAuthNotice next={next} />
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox error={error ?? (closed ? 'Les inscriptions sont fermées sur cette instance. Demandez une invitation à son administrateur.' : null)} />
        <Field label="Nom">
          <Input icon={UserIcon} required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marie Dupont" autoFocus />
        </Field>
        <Field label="Email">
          <Input icon={Mail} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" />
        </Field>
        <Field label="Mot de passe" hint="6 caractères minimum.">
          <Input icon={Lock} type="password" required minLength={6} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={loading}>
          Créer mon compte
        </Button>
      </form>
    </AuthShell>
  );
}

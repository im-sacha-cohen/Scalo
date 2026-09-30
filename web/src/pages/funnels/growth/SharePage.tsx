// /share/:token — public, read-only preview of a shared funnel and "Importer dans mon compte" (sign-in required).
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Download, Eye, Link2Off, Lock, X } from 'lucide-react';
import { renderPageDocument, type PageContent } from '@scalo/shared';
import { growthApi } from '../../../lib/growth-api';
import { useAuth } from '../../../lib/auth';
import { useLoad } from '../../../lib/hooks';
import { STEP_TYPE_LABELS } from '../../../lib/format';
import { Badge, Button, Card, EmptyState, PageLoader } from '../../../components/ui';
import { Logo } from '../../../components/Layout';
import { DocThumb } from '../../../builder/TemplateGallery';
import { useToast } from '../../../components/Toast';

// Content of another account: rendered in fully sandboxed frames (no scripts, no forms, opaque origin).
const render = (content: PageContent, title: string) => renderPageDocument(content, { title, nextUrl: '#', formAction: '#', baseUrl: window.location.origin });

export function SharePage() {
  const { token = '' } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, loading } = useLoad(() => growthApi.sharedFunnel(token), [token]);
  const [open, setOpen] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const thumbs = useMemo(() => (data?.steps ?? []).map((s) => render(s.content, s.name)), [data]);

  const importIt = async () => {
    if (!user) {
      navigate(`/login?next=${encodeURIComponent(`/share/${token}`)}`);
      return;
    }
    setImporting(true);
    try {
      const r = await growthApi.importShared(token);
      toast.success('Tunnel importé dans votre compte');
      for (const w of r.warnings) toast.error(w);
      navigate(`/funnels/${r.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setImporting(false);
    }
  };

  const openStep = open !== null ? data?.steps[open] : null;

  return (
    <div className="min-h-full bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
          <Link to={user ? '/' : '/home'} aria-label="Accueil">
            <Logo />
          </Link>
          {user ? (
            <span className="text-sm text-slate-500">Connecté : {user.email}</span>
          ) : (
            <Link to={`/login?next=${encodeURIComponent(`/share/${token}`)}`} className="text-sm font-medium text-slate-600 hover:text-slate-900">
              Se connecter
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {loading && !data ? (
          <PageLoader />
        ) : error || !data ? (
          <EmptyState icon={Link2Off} title="Lien de partage invalide" description={error ?? 'Ce lien a peut-être été désactivé par son propriétaire.'} action={<Link to="/"><Button variant="secondary">Retour</Button></Link>} />
        ) : (
          <>
            <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm text-slate-500">Tunnel partagé par {data.owner}</p>
                <h1 className="truncate text-2xl font-bold tracking-tight text-slate-900">{data.name}</h1>
                <p className="mt-1 text-sm text-slate-500">
                  {data.steps.length} étape{data.steps.length > 1 ? 's' : ''} · aperçu en lecture seule. L’import crée une copie indépendante dans votre compte (sans contacts ni statistiques).
                </p>
              </div>
              <Button size="lg" icon={Download} loading={importing} onClick={importIt}>
                {user ? 'Importer dans mon compte' : 'Se connecter pour importer'}
              </Button>
            </div>

            <ol className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {data.steps.map((s, i) => (
                <li key={i}>
                  <Card padded={false} className="overflow-hidden">
                    <button type="button" className="group relative block w-full" onClick={() => setOpen(i)} aria-label={`Aperçu de ${s.name}`}>
                      <DocThumb html={thumbs[i] ?? ''} width={360} ratio={0.7} />
                      <span className="absolute inset-0 flex items-center justify-center bg-slate-900/0 opacity-0 transition group-hover:bg-slate-900/40 group-hover:opacity-100">
                        <span className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-slate-800">
                          <Eye size={15} /> Aperçu
                        </span>
                      </span>
                    </button>
                    <div className="flex items-center gap-2 border-t border-slate-100 px-3 py-2.5">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-xs font-bold text-slate-600">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">{s.name}</span>
                      <Badge>{STEP_TYPE_LABELS[s.type] ?? s.type}</Badge>
                      {s.protected && (
                        <span title="Page à accès restreint" className="text-amber-600">
                          <Lock size={13} />
                        </span>
                      )}
                    </div>
                  </Card>
                </li>
              ))}
            </ol>
          </>
        )}
      </main>

      {openStep && (
        <div className="fixed inset-0 z-50 flex flex-col bg-slate-900/70 p-4" role="dialog" aria-modal="true" aria-label={`Aperçu : ${openStep.name}`}>
          <div className="mx-auto flex w-full max-w-5xl items-center justify-between pb-3 text-white">
            <span className="font-semibold">{openStep.name}</span>
            <button type="button" onClick={() => setOpen(null)} className="rounded-lg p-1.5 hover:bg-white/10" aria-label="Fermer l’aperçu" autoFocus>
              <X size={20} />
            </button>
          </div>
          <iframe title={`Aperçu de ${openStep.name}`} sandbox="" srcDoc={render(openStep.content, openStep.name)} className="mx-auto w-full max-w-5xl flex-1 rounded-xl border-0 bg-white" />
        </div>
      )}
    </div>
  );
}

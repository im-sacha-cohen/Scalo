import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ArrowLeft, ExternalLink, Eye, Lock, LockOpen } from 'lucide-react';
import type { PageContent, Step } from '@scalo/shared';
import { api } from '../../lib/api';
import { useBeforeUnload, useLoad, useNow } from '../../lib/hooks';
import { Builder, type BuilderHandle } from '../../builder/Builder';
import { PreviewMenu, SaveButton, SaveStatus } from '../../builder/bar';
import { ErrorState, Spinner, cx } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useUnsavedGuard } from '../../components/useUnsavedGuard';
import { PageSwitcher } from './PageSwitcher';
import { accessLabel, isProtected, StepAccessModal } from './StepAccessModal';
import { growthApi } from '../../lib/growth-api';
import { VariantSwitcher } from './growth/VariantSwitcher';

/** Remounts the whole editor when switching page, so no state (content, history, autosave) leaks between steps. */
export function StepEditorPage() {
  const { stepId } = useParams();
  const [params] = useSearchParams();
  // `?variant=<id>`: edit an A/B test variant of the page instead of the original
  return <StepEditor key={`${stepId}:${params.get('variant') ?? ''}`} />;
}

function StepEditor() {
  const { id, stepId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const funnelId = Number(id);
  const sid = Number(stepId);
  const variantId = Number(params.get('variant')) || 0;
  const toast = useToast();

  const { data, setData, error, reload } = useLoad(async () => {
    const [step, funnel, ab, variant] = await Promise.all([
      api.step(sid),
      api.funnel(funnelId),
      growthApi.abTest(sid).catch(() => null),
      variantId ? growthApi.variant(variantId) : Promise.resolve(null),
    ]);
    // the edited document: the variant's content, or the page itself
    return { step: variant ? { ...step, content: variant.content } : step, funnel, variants: ab?.variants ?? [], variant };
  }, [sid, funnelId, variantId]);

  const [content, setContent] = useState<PageContent | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const failedJson = useRef<string | null>(null);
  const builder = useRef<BuilderHandle>(null);

  useEffect(() => {
    if (!data) return;
    setContent(data.step.content);
    setSavedJson(JSON.stringify(data.step.content));
  }, [data]);

  const json = useMemo(() => (content ? JSON.stringify(content) : ''), [content]);
  const dirty = !!content && json !== savedJson;

  const leaving = useRef(false);
  const [accessOpen, setAccessOpen] = useState(false);
  useBeforeUnload(dirty);
  useUnsavedGuard(dirty, leaving);

  const contentRef = useRef(content);
  contentRef.current = content;

  const save = useCallback(async () => {
    const c = contentRef.current;
    if (!c) return false;
    setSaving(true);
    try {
      if (variantId) await growthApi.updateVariant(variantId, { content: c });
      else await api.updateStep(sid, { content: c });
      setSavedJson(JSON.stringify(c));
      setSavedAt(Date.now());
      failedJson.current = null;
      return true;
    } catch (e) {
      failedJson.current = JSON.stringify(c);
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [sid, variantId, toast]);

  // autosave: 2.5 s after the last change (not retried for the same content after a failure)
  useEffect(() => {
    if (!dirty || saving || failedJson.current === json) return;
    const t = setTimeout(() => save(), 2500);
    return () => clearTimeout(t);
  }, [json, dirty, saving, save]);
  const now = useNow(5000, savedAt !== null);
  const ago = savedAt ? Math.max(0, Math.round((now - savedAt) / 1000)) : 0;
  const agoLabel = ago < 10 ? 'à l’instant' : ago < 60 ? `il y a ${ago} s` : `il y a ${Math.round(ago / 60)} min`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  /** Switch to another step (of this funnel or another one): save first, then navigate without leaving the editor. */
  const goTo = async (fid: number, sid2: number) => {
    if (dirty && !(await save())) return;
    leaving.current = true;
    navigate(`/funnels/${fid}/steps/${sid2}/edit`);
  };
  /** Switch between the original page and its A/B variants (save first). */
  const goToVariant = async (vid: number) => {
    if (dirty && !(await save())) return;
    leaving.current = true;
    navigate(`/funnels/${funnelId}/steps/${sid}/edit${vid ? `?variant=${vid}` : ''}`);
  };

  const onAccessSaved = (s: Step) => {
    if (!data) return;
    setData({
      ...data,
      step: { ...data.step, access: s.access, slug: s.slug, preview_url: s.preview_url },
      funnel: { ...data.funnel, steps: data.funnel.steps?.map((x) => (x.id === s.id ? { ...x, access: s.access, slug: s.slug } : x)) },
    });
  };

  const preview = async () => {
    if (!data) return;
    const base = data.step.preview_url || `/p/${data.funnel.slug}/${data.step.slug}?preview=1`;
    const url = variantId ? `${base}&variant=${variantId}` : base;
    if (!dirty) {
      window.open(url, '_blank');
      return;
    }
    // open synchronously (avoids popup blockers), then navigate once saved
    const w = window.open('about:blank', '_blank');
    const ok = await save();
    if (w) {
      if (ok) w.location.href = url;
      else w.close();
    }
  };

  if (error && !data) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }

  if (!data || !content) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-100 text-sm text-slate-500">
        <Spinner size={32} />
        Chargement de l’éditeur…
      </div>
    );
  }

  const { step, funnel } = data;
  const locked = isProtected(step.access);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Builder
        ref={builder}
        content={content}
        onChange={setContent}
        mode="page"
        title={step.name}
        barStart={
          <>
            <Link
              to={`/funnels/${funnel.id}?step=${step.id}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              title="Retour au tunnel"
              aria-label="Retour au tunnel"
            >
              <ArrowLeft size={17} />
            </Link>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />
            <PageSwitcher funnel={funnel} step={step} onGo={goTo} />
            <VariantSwitcher variants={data.variants} current={variantId} onGo={goToVariant} />
          </>
        }
        barEnd={({ preview: inEditor, togglePreview }) => (
          <>
            <SaveStatus saving={saving} dirty={dirty} detail={savedAt ? `Enregistré ${agoLabel} — enregistrement automatique activé` : 'Enregistrement automatique activé'} />
            <button
              type="button"
              onClick={() => setAccessOpen(true)}
              className={cx(
                'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-sm font-medium whitespace-nowrap transition-colors',
                locked ? 'bg-amber-50 text-amber-800 hover:bg-amber-100' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
              )}
              title={locked ? `Page protégée : ${accessLabel(step.access)}` : 'Accès à la page : publique'}
              aria-label="Accès et sécurité de la page"
            >
              {locked ? <Lock size={15} /> : <LockOpen size={15} />}
              {locked && <span className="hidden max-w-[120px] truncate 2xl:inline">{accessLabel(step.access)}</span>}
            </button>
            <PreviewMenu
              preview={inEditor}
              onToggle={togglePreview}
              items={[
                { label: inEditor ? 'Revenir à l’édition' : 'Aperçu dans l’éditeur', description: 'Rendu exact, liens désactivés', icon: Eye, onClick: togglePreview },
                { label: 'Ouvrir la page publique', description: 'Aperçu sécurisé, sans compter de vue', icon: ExternalLink, onClick: preview },
              ]}
            />
            <SaveButton onClick={save} saving={saving} dirty={dirty} />
          </>
        )}
      />
      <StepAccessModal step={accessOpen ? step : null} onClose={() => setAccessOpen(false)} onSaved={onAccessSaved} />
    </div>
  );
}

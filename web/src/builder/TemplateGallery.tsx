import { memo, useMemo, useState } from 'react';
import { Check, FileText, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_SETTINGS,
  EMAIL_TEMPLATES,
  PAGE_TEMPLATES,
  renderEmailDocument,
  renderPageDocument,
  type PageContent,
} from '@scalo/shared';
import { Modal } from '../components/Modal';
import { Button, cx } from '../components/ui';
import type { BuilderMode } from './context';

const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie@exemple.fr', phone: '' };

/** Scaled, script-less preview of a full document. */
export const DocThumb = memo(function DocThumb({ html, width = 300, docWidth = 1280, ratio = 0.68 }: { html: string; width?: number; docWidth?: number; ratio?: number }) {
  const scale = width / docWidth;
  const height = Math.round(width * ratio);
  return (
    <div className="relative overflow-hidden bg-white" style={{ width, height }}>
      <iframe
        title="Aperçu du modèle"
        sandbox=""
        srcDoc={html}
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0"
        style={{ width: docWidth, height: height / scale, transform: `scale(${scale})` }}
      />
    </div>
  );
});

export function usePageTemplatePreviews() {
  return useMemo(
    () =>
      PAGE_TEMPLATES.map((t) => {
        const content = t.build();
        return { t, content, html: renderPageDocument(content, { title: t.name, nextUrl: '#', formAction: '#', vars: EXAMPLE_VARS }) };
      }),
    [],
  );
}

const BLANK_PAGE: PageContent = { settings: { ...DEFAULT_SETTINGS }, blocks: [] };
const BLANK_EMAIL: PageContent = { settings: { ...DEFAULT_EMAIL_SETTINGS }, blocks: [] };

export function TemplateGallery({ open, mode, hasContent, onClose, onPick }: { open: boolean; mode: BuilderMode; hasContent: boolean; onClose: () => void; onPick: (c: PageContent) => void }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      title={mode === 'email' ? 'Modèles d’emails' : 'Modèles de pages'}
      description="Des mises en page professionnelles, entièrement modifiables. Le modèle remplace le contenu actuel (annulable avec Ctrl+Z)."
    >
      {open && <GalleryBody mode={mode} hasContent={hasContent} onPick={onPick} />}
    </Modal>
  );
}

function GalleryBody({ mode, hasContent, onPick }: { mode: BuilderMode; hasContent: boolean; onPick: (c: PageContent) => void }) {
  const [cat, setCat] = useState<string>('Tous');
  const [pending, setPending] = useState<{ name: string; content: PageContent } | null>(null);
  const pages = usePageTemplatePreviews();
  const emails = useMemo(
    () =>
      mode === 'email'
        ? EMAIL_TEMPLATES.map((t) => {
            const content = t.build();
            return { t, content, html: renderEmailDocument(content, { subject: t.name, vars: EXAMPLE_VARS }) };
          })
        : [],
    [mode],
  );

  const choose = (name: string, content: PageContent) => {
    if (hasContent) setPending({ name, content });
    else onPick(content);
  };

  const cats = ['Tous', ...new Set(PAGE_TEMPLATES.map((t) => t.category))];

  return (
    <div>
      {mode === 'page' && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              className={cx('h-8 rounded-full px-3.5 text-sm font-medium transition-colors', cat === c ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] justify-items-center gap-5">
        {mode === 'page'
          ? pages
              .filter((p) => cat === 'Tous' || p.t.category === cat)
              .map((p) => <Card key={p.t.id} name={p.t.name} description={p.t.description} badge={p.t.category} onClick={() => choose(p.t.name, p.content)} thumb={<DocThumb html={p.html} />} />)
          : emails.map((p) => (
              <Card key={p.t.id} name={p.t.name} description={p.t.description} onClick={() => choose(p.t.name, p.content)} thumb={<DocThumb html={p.html} docWidth={680} ratio={0.9} />} />
            ))}
        <Card
          name={mode === 'email' ? 'Email vierge' : 'Page vierge'}
          description="Partir de zéro avec les blocs et sections."
          onClick={() => choose('vierge', mode === 'email' ? BLANK_EMAIL : BLANK_PAGE)}
          thumb={
            <div className="flex items-center justify-center bg-slate-50 text-slate-300" style={{ width: 300, height: mode === 'email' ? 270 : 204 }}>
              <FileText size={44} />
            </div>
          }
        />
      </div>

      {pending && (
        <div className="sticky bottom-0 mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-pop">
          <TriangleAlert size={18} className="shrink-0" />
          <span className="flex-1">
            Remplacer le contenu actuel par « {pending.name} » ? Vous pourrez revenir en arrière avec Ctrl+Z.
          </span>
          <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
            Annuler
          </Button>
          <Button size="sm" icon={Check} onClick={() => onPick(pending.content)}>
            Remplacer
          </Button>
        </div>
      )}
    </div>
  );
}

function Card({ name, description, badge, thumb, onClick }: { name: string; description: string; badge?: string; thumb: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-[300px] overflow-hidden rounded-xl border border-slate-200 bg-white text-left shadow-card transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-pop"
    >
      <div className="relative border-b border-slate-100">
        {thumb}
        <span className="absolute inset-0 flex items-center justify-center bg-slate-900/0 opacity-0 transition-all group-hover:bg-slate-900/35 group-hover:opacity-100">
          <span className="rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow">Utiliser ce modèle</span>
        </span>
      </div>
      <div className="px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-900">{name}</span>
          {badge && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10.5px] font-medium text-slate-500">{badge}</span>}
        </div>
        <p className="mt-0.5 text-xs leading-snug text-slate-500">{description}</p>
      </div>
    </button>
  );
}

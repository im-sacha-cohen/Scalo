import { memo, useMemo, useState } from 'react';
import { Check, FileText, Palette, TriangleAlert } from 'lucide-react';
import {
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_SETTINGS,
  EMAIL_TEMPLATES,
  KITS,
  KIT_EMAILS,
  KIT_EMAIL_KINDS,
  KIT_PAGES,
  KIT_PAGE_KINDS,
  PAGE_TEMPLATES,
  getKit,
  kitEmail,
  kitPage,
  kitSettings,
  renderEmailDocument,
  renderPageDocument,
  type PageContent,
} from '@scalo/shared';
import { Modal } from '../components/Modal';
import { Button, cx } from '../components/ui';
import type { BuilderMode } from './context';
import { Chips, KitSwatch, SearchBox, kitEmailPreview, kitPagePreview, textMatches } from './kits';

const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie@exemple.fr', phone: '' };

/** Previews run in script-less sandboxed frames: remove scripts (countdown) instead of letting the browser block them. */
export const stripScripts = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, '');

/** Scaled, script-less preview of a full document. */
export const DocThumb = memo(function DocThumb({ html, width = 300, docWidth = 1280, ratio = 0.68 }: { html: string; width?: number; docWidth?: number; ratio?: number }) {
  const scale = width / docWidth;
  const height = Math.round(width * ratio);
  return (
    <div className="relative overflow-hidden bg-white" style={{ width, height }}>
      <iframe
        title="Aperçu du modèle"
        sandbox=""
        srcDoc={stripScripts(html)}
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

export function TemplateGallery({
  open,
  mode,
  hasContent,
  currentKit,
  onClose,
  onPick,
  onApplyKit,
}: {
  open: boolean;
  mode: BuilderMode;
  hasContent: boolean;
  /** Kit of the page being edited (shown first). */
  currentKit?: string | null;
  onClose: () => void;
  onPick: (c: PageContent) => void;
  /** Restyles the current page with a kit's tokens without touching its blocks. */
  onApplyKit?: (kitId: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="full"
      title={mode === 'email' ? 'Modèles d’emails' : 'Modèles de pages'}
      description="Des kits dont toutes les pages et tous les emails partagent la même identité. Le modèle remplace le contenu actuel (annulable avec Ctrl+Z)."
    >
      {open && <GalleryBody mode={mode} hasContent={hasContent} currentKit={currentKit ?? null} onPick={onPick} onApplyKit={onApplyKit} />}
    </Modal>
  );
}

const CLASSIC = 'classic';

function GalleryBody({ mode, hasContent, currentKit, onPick, onApplyKit }: { mode: BuilderMode; hasContent: boolean; currentKit: string | null; onPick: (c: PageContent) => void; onApplyKit?: (kitId: string) => void }) {
  const [group, setGroup] = useState<string>(currentKit && getKit(currentKit) ? currentKit : KITS[0]!.id);
  const [cat, setCat] = useState<string>('Tous');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<{ name: string; content: PageContent } | null>(null);
  const classicPages = usePageTemplatePreviews();
  const classicEmails = useMemo(
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

  const kit = getKit(group);
  const searching = query.trim() !== '';
  // a search looks in every kit and in the classic templates; otherwise only the selected group is shown
  const kitsShown = searching ? KITS : kit ? [kit] : [];
  const showClassic = searching || group === CLASSIC;
  const cats = ['Tous', ...new Set([...KIT_PAGE_KINDS.map((k) => KIT_PAGES[k].category), ...PAGE_TEMPLATES.map((t) => t.category)])];
  const catOk = (c: string) => cat === 'Tous' || c === cat;

  const cards: React.ReactNode[] = [];
  for (const k of kitsShown) {
    if (mode === 'page') {
      for (const kind of KIT_PAGE_KINDS) {
        const meta = KIT_PAGES[kind];
        if (!catOk(meta.category) || !textMatches(`${k.name} ${k.universe} ${meta.name} ${meta.description} ${meta.category}`, query)) continue;
        cards.push(
          <Card
            key={`${k.id}:${kind}`}
            data={`${k.id}:${kind}`}
            name={searching ? `${k.name} — ${meta.name}` : meta.name}
            description={meta.description}
            badge={meta.category}
            onClick={() => choose(`${k.name} — ${meta.name}`, kitPage(k.id, kind)!)}
            thumb={<DocThumb html={kitPagePreview(k.id, kind)} />}
          />,
        );
      }
    } else {
      for (const kind of KIT_EMAIL_KINDS) {
        const meta = KIT_EMAILS[kind];
        if (!textMatches(`${k.name} ${k.universe} ${meta.name} ${meta.description}`, query)) continue;
        cards.push(
          <Card
            key={`${k.id}:${kind}`}
            data={`${k.id}:${kind}`}
            name={searching ? `${k.name} — ${meta.name}` : meta.name}
            description={meta.description}
            onClick={() => choose(`${k.name} — ${meta.name}`, kitEmail(k.id, kind)!.content)}
            thumb={<DocThumb html={kitEmailPreview(k.id, kind)} docWidth={680} ratio={0.9} />}
          />,
        );
      }
    }
  }
  if (showClassic) {
    if (mode === 'page') {
      for (const p of classicPages) {
        if (!catOk(p.t.category) || !textMatches(`${p.t.name} ${p.t.description} ${p.t.category} classique`, query)) continue;
        cards.push(<Card key={p.t.id} data={p.t.id} name={p.t.name} description={p.t.description} badge={p.t.category} onClick={() => choose(p.t.name, p.t.build())} thumb={<DocThumb html={p.html} />} />);
      }
    } else {
      for (const p of classicEmails) {
        if (!textMatches(`${p.t.name} ${p.t.description} classique`, query)) continue;
        cards.push(<Card key={p.t.id} data={p.t.id} name={p.t.name} description={p.t.description} onClick={() => choose(p.t.name, p.t.build())} thumb={<DocThumb html={p.html} docWidth={680} ratio={0.9} />} />);
      }
    }
  }
  const blank = (): PageContent => (kit ? { settings: kitSettings(kit, mode), blocks: [] } : mode === 'email' ? BLANK_EMAIL : BLANK_PAGE);

  return (
    <div className="grid items-start gap-6 md:grid-cols-[210px_minmax(0,1fr)]">
      <nav aria-label="Kits" className="md:sticky md:top-0">
        <p className="px-2 pb-1.5 text-xs font-medium text-slate-400">Kits</p>
        <ul className="flex gap-1 overflow-x-auto md:block md:space-y-0.5">
          {KITS.map((k) => (
            <li key={k.id}>
              <GroupButton active={!searching && group === k.id} onClick={() => { setGroup(k.id); setQuery(''); }} data={k.id}>
                <span className="h-3 w-3 shrink-0 rounded-full ring-1 ring-slate-900/10" style={{ background: k.tokens.accent }} />
                <span className="flex-1 truncate">{k.name}</span>
                {currentKit === k.id && <span className="text-[10px] font-normal text-brand-600">actuel</span>}
              </GroupButton>
            </li>
          ))}
          <li className="md:mt-2 md:border-t md:border-slate-100 md:pt-2">
            <GroupButton active={!searching && group === CLASSIC} onClick={() => { setGroup(CLASSIC); setQuery(''); }} data={CLASSIC}>
              <span className="h-3 w-3 shrink-0 rounded-full bg-slate-300" />
              <span className="flex-1 truncate">Modèles classiques</span>
            </GroupButton>
          </li>
        </ul>
      </nav>

      <div>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-[200px] flex-1">
            <SearchBox value={query} onChange={setQuery} placeholder={mode === 'email' ? 'Rechercher un email (bienvenue, relance…)' : 'Rechercher une page (capture, webinaire…)'} />
          </div>
          {mode === 'page' && <Chips label="Type de page" value={cat} onChange={setCat} options={cats.map((c): [string, string] => [c, c])} />}
        </div>

        {kit && !searching && (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                Kit {kit.name} <KitSwatch kit={kit} />
                <span className="text-xs font-normal text-slate-500">{kit.universe}</span>
              </p>
              <p className="mt-0.5 text-xs text-slate-500">{kit.pitch}</p>
            </div>
            {onApplyKit && (
              <Button variant="secondary" size="sm" icon={Palette} onClick={() => onApplyKit(kit.id)} title="Change les polices, les couleurs et le style des boutons et des cartes, sans toucher aux blocs.">
                Appliquer ce kit à {mode === 'email' ? 'cet email' : 'cette page'}
              </Button>
            )}
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] justify-items-center gap-5">
          {cards}
          {!searching && (
            <Card
              data="blank"
              name={kit ? `${mode === 'email' ? 'Email vierge' : 'Page vierge'} — kit ${kit.name}` : mode === 'email' ? 'Email vierge' : 'Page vierge'}
              description={kit ? 'Partir de zéro : les blocs et sections prendront le style du kit.' : 'Partir de zéro avec les blocs et sections.'}
              onClick={() => choose('vierge', blank())}
              thumb={
                <div className="flex items-center justify-center text-slate-300" style={{ width: 300, height: mode === 'email' ? 270 : 204, background: kit ? kit.tokens.alt : '#f8fafc' }}>
                  <FileText size={44} style={kit ? { color: kit.tokens.accent2 } : undefined} />
                </div>
              }
            />
          )}
        </div>
        {searching && cards.length === 0 && <p className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">Aucun modèle ne correspond à « {query.trim()} ».</p>}

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
    </div>
  );
}

function GroupButton({ active, onClick, children, data }: { active: boolean; onClick: () => void; children: React.ReactNode; data: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-gallery-group={data}
      onClick={onClick}
      className={cx('flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm font-medium whitespace-nowrap transition-colors', active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')}
    >
      {children}
    </button>
  );
}

function Card({ name, description, badge, thumb, onClick, data }: { name: string; description: string; badge?: string; thumb: React.ReactNode; onClick: () => void; data?: string }) {
  return (
    <button
      type="button"
      data-template={data}
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

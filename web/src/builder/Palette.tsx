import { memo, useEffect, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronRight, Columns2, LayoutGrid, Search, Trash } from 'lucide-react';
import {
  BLOCK_LABELS,
  EMAIL_BLOCK_TYPES,
  PAGE_BLOCK_TYPES,
  SECTION_TEMPLATES,
  buildSection,
  cloneBlock,
  findBlock,
  renderPageDocument,
  renderEmailDocument,
  DEFAULT_SETTINGS,
  DEFAULT_EMAIL_SETTINGS,
  KIT_SECTIONS,
  getKit,
  kitSection,
  kitSectionList,
  kitSettings,
  type KitSectionKind,
  type Block,
  type BlockType,
  type SectionTemplate,
} from '@scalo/shared';
import { cx } from '../components/ui';
import { useBuilder, type BuilderMode, type InsertTarget } from './context';
import { BLOCK_DESCRIPTIONS, BLOCK_ICONS, PALETTE_GROUPS, blockSummary } from './meta';
import { loadSavedSections, storeSavedSections, useUi, type SavedSection } from './store';
import { DocThumb } from './TemplateGallery';

const POPULAR: BlockType[] = ['heading', 'text', 'image', 'button', 'form', 'section', 'columns'];

/* ---------------- "Ajouter" panel ---------------- */

export function AddPanel({ mode }: { mode: BuilderMode }) {
  const { ops } = useBuilder();
  const [q, setQ] = useState('');
  const allowed = new Set<BlockType>(mode === 'email' ? EMAIL_BLOCK_TYPES : PAGE_BLOCK_TYPES);
  const popular = POPULAR.filter((t) => allowed.has(t));
  const needle = q.trim().toLowerCase();
  const results = needle
    ? [...allowed].filter((t) => `${BLOCK_LABELS[t]} ${BLOCK_DESCRIPTIONS[t]}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').includes(needle.normalize('NFD').replace(/[\u0300-\u036f]/g, '')))
    : null;

  return (
    <>
      <div className="px-3 pb-2">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results?.[0]) ops.insertType(results[0]);
              if (e.key === 'Escape') setQ('');
            }}
            placeholder="Rechercher un bloc…"
            className="h-8 w-full rounded-lg border border-slate-200 bg-slate-50 pr-2 pl-8 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:bg-white focus:ring-4 focus:ring-brand-500/10"
          />
        </div>
      </div>
      <div className="scalo-scroll flex-1 overflow-y-auto px-3 pb-4">
        {results ? (
          results.length ? (
            <BlockGrid types={results} onAdd={(t) => ops.insertType(t)} />
          ) : (
            <p className="px-1 py-6 text-center text-xs text-slate-400">Aucun bloc ne correspond à « {q} ».</p>
          )
        ) : (
          <>
            <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-slate-400">Essentiels</p>
            <BlockGrid types={popular} onAdd={(t) => ops.insertType(t)} />
            <div className="mt-3 space-y-0.5">
              {PALETTE_GROUPS.map((g) => {
                const types = g.types.filter((t) => allowed.has(t) && !popular.includes(t));
                if (!types.length) return null;
                return <CategoryGroup key={g.title} title={g.title} types={types} onAdd={(t) => ops.insertType(t)} />;
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

const openCats = new Set<string>();

function CategoryGroup({ title, types, onAdd }: { title: string; types: BlockType[]; onAdd: (t: BlockType) => void }) {
  const [open, setOpen] = useState(() => openCats.has(title));
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (open) openCats.delete(title);
          else openCats.add(title);
          setOpen(!open);
        }}
        aria-expanded={open}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-1 text-left text-xs font-medium text-slate-500 hover:text-slate-900"
      >
        <ChevronRight size={13} className={cx('text-slate-400 transition-transform', open && 'rotate-90')} />
        {title}
        <span className="ml-auto text-[11px] font-normal text-slate-300 tabular-nums">{types.length}</span>
      </button>
      {open && (
        <div className="pb-2">
          <BlockGrid types={types} onAdd={onAdd} />
        </div>
      )}
    </div>
  );
}

function BlockGrid({ types, onAdd }: { types: BlockType[]; onAdd: (t: BlockType) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {types.map((t) => (
        <PaletteItem key={t} type={t} onAdd={() => onAdd(t)} />
      ))}
    </div>
  );
}

function PaletteItem({ type, onAdd }: { type: BlockType; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette:${type}`, data: { from: 'palette', item: { kind: 'type', type } } });
  const Icon = BLOCK_ICONS[type];
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onAdd}
      title={`${BLOCK_DESCRIPTIONS[type]} — cliquez pour ajouter, ou glissez sur la page`}
      className={cx(
        'group flex h-10 cursor-grab items-center gap-2 rounded-lg border px-2 text-left text-[13px] font-medium text-slate-700 transition-colors active:cursor-grabbing',
        isDragging ? 'border-brand-300 opacity-40' : 'border-slate-200/80 bg-white hover:border-slate-300 hover:bg-slate-50',
      )}
    >
      <Icon size={16} strokeWidth={1.85} className="shrink-0 text-slate-400 transition-colors group-hover:text-brand-600" />
      <span className="truncate">{BLOCK_LABELS[type]}</span>
    </button>
  );
}

/* ---------------- section library ---------------- */

function useSavedSections(mode: BuilderMode) {
  const [list, setList] = useState<SavedSection[]>(() => loadSavedSections());
  useEffect(() => {
    const reload = () => setList(loadSavedSections());
    window.addEventListener('scalo-saved-sections', reload);
    window.addEventListener('storage', reload);
    return () => {
      window.removeEventListener('scalo-saved-sections', reload);
      window.removeEventListener('storage', reload);
    };
  }, []);
  return list.filter((s) => s.mode === mode);
}

export function SectionsPanel({ mode, accent, kitId }: { mode: BuilderMode; accent: string; kitId?: string | null }) {
  const { ops, getContent, ui } = useBuilder();
  const saved = useSavedSections(mode);
  const templates = SECTION_TEMPLATES.filter((s) => s.modes.includes(mode));
  const cats = [...new Set(templates.map((t) => t.category))];
  const kit = getKit(kitId);

  /** Sections are inserted at the top level: after the selected top-level block, else at the end. */
  const rootTarget = (): InsertTarget => {
    const bs = getContent().blocks ?? [];
    const sel = ui.get().selectedId;
    const loc = sel ? findBlock(bs, sel) : null;
    const top = loc ? (loc.path[0] ?? loc.block) : null;
    const i = top ? bs.findIndex((b) => b.id === top.id) : -1;
    return { list: 'root', index: i >= 0 ? i + 1 : bs.length };
  };

  return (
    <div className="scalo-scroll flex-1 overflow-y-auto px-3 pb-4">
      {saved.length > 0 && (
        <div className="mb-4">
          <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-slate-400">Mes sections</p>
          <div className="space-y-1.5">
            {saved.map((s) => (
              <SavedItem key={s.id} item={s} onAdd={() => ops.insertBlocks([cloneBlock(s.block)], rootTarget())} />
            ))}
          </div>
        </div>
      )}
      {kit && (
        <div className="mb-4" data-kit-sections={kit.id}>
          <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-slate-400">Sections du kit {kit.name}</p>
          <div className="space-y-2">
            {kitSectionList(kit.id).map((s) => (
              <KitSectionItem key={s.id} id={s.id} kitId={kit.id} kind={s.kind} mode={mode} onAdd={() => ops.insertBlocks(kitSection(kit.id, s.kind, mode), rootTarget())} />
            ))}
          </div>
        </div>
      )}
      {cats.map((c) => (
        <div key={c} className="mb-4">
          <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-slate-400">{c}</p>
          <div className="space-y-2">
            {templates
              .filter((t) => t.category === c)
              .map((t) => (
                <SectionItem key={t.id} t={t} mode={mode} accent={accent} onAdd={() => ops.insertBlocks([buildSection(t, mode, accent)], rootTarget())} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const SectionItem = memo(function SectionItem({ t, mode, accent, onAdd }: { t: SectionTemplate; mode: BuilderMode; accent: string; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `section:${t.id}`, data: { from: 'palette', item: { kind: 'section', id: t.id } } });
  const html = useMemo(() => {
    const block = buildSection(t, mode, accent);
    return mode === 'email'
      ? renderEmailDocument({ settings: { ...DEFAULT_EMAIL_SETTINGS, accent }, blocks: [block] }, { subject: t.name })
      : renderPageDocument({ settings: { ...DEFAULT_SETTINGS, accent, maxWidth: 1100, contentPadding: 0, background: '#ffffff' }, blocks: [block] }, { title: t.name });
  }, [t, mode, accent]);
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onAdd}
      className={cx(
        'group block w-full cursor-grab overflow-hidden rounded-lg border bg-white text-left transition-all active:cursor-grabbing',
        isDragging ? 'border-brand-300 opacity-40' : 'border-slate-200 hover:border-slate-300 hover:shadow-card',
      )}
    >
      <div className="pointer-events-none border-b border-slate-100">
        <DocThumb html={html} width={254} docWidth={mode === 'email' ? 640 : 1280} ratio={0.42} />
      </div>
      <div className="px-2.5 py-1.5 text-xs font-medium text-slate-700 group-hover:text-slate-900">{t.name}</div>
    </button>
  );
});

/** A section of the page's kit (header, hero, testimonials…): same look as the rest of the page. */
const KitSectionItem = memo(function KitSectionItem({ id, kitId, kind, mode, onAdd }: { id: string; kitId: string; kind: KitSectionKind; mode: BuilderMode; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `section:${id}`, data: { from: 'palette', item: { kind: 'section', id } } });
  const html = useMemo(() => {
    const kit = getKit(kitId)!;
    const content = { settings: kitSettings(kit, mode), blocks: kitSection(kitId, kind, mode) };
    return mode === 'email' ? renderEmailDocument(content, { subject: KIT_SECTIONS[kind].name }) : renderPageDocument(content, { title: KIT_SECTIONS[kind].name });
  }, [kitId, kind, mode]);
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onAdd}
      data-kit-section={kind}
      className={cx(
        'group block w-full cursor-grab overflow-hidden rounded-lg border bg-white text-left transition-all active:cursor-grabbing',
        isDragging ? 'border-brand-300 opacity-40' : 'border-slate-200 hover:border-slate-300 hover:shadow-card',
      )}
    >
      <div className="pointer-events-none border-b border-slate-100">
        <DocThumb html={html} width={254} docWidth={mode === 'email' ? 640 : 1280} ratio={0.42} />
      </div>
      <div className="px-2.5 py-1.5 text-xs font-medium text-slate-700 group-hover:text-slate-900">{KIT_SECTIONS[kind].name}</div>
    </button>
  );
});

function SavedItem({ item, onAdd }: { item: SavedSection; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: `saved:${item.id}`, data: { from: 'palette', item: { kind: 'saved', id: item.id } } });
  const Icon = BLOCK_ICONS[item.block.type] ?? Columns2;
  return (
    <div className="group flex items-center gap-1 rounded-lg border border-slate-200 bg-white pr-1 hover:border-slate-300 hover:bg-slate-50">
      <button ref={setNodeRef} type="button" {...attributes} {...listeners} onClick={onAdd} className="flex min-w-0 flex-1 cursor-grab items-center gap-2 px-2 py-2 text-left text-xs font-medium text-slate-700">
        <Icon size={14} className="shrink-0 text-slate-400" />
        <span className="truncate">{item.name}</span>
      </button>
      <button
        type="button"
        title="Supprimer ce modèle"
        onClick={() => {
          if (!window.confirm(`Supprimer « ${item.name} » de vos sections ?`)) return;
          storeSavedSections(loadSavedSections().filter((s) => s.id !== item.id));
        }}
        className="rounded p-1 text-slate-300 opacity-0 group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600"
      >
        <Trash size={13} />
      </button>
    </div>
  );
}

/* ---------------- layers ---------------- */

export function LayersPanel({ blocks }: { blocks: Block[] }) {
  return (
    <div className="scalo-scroll flex-1 overflow-y-auto px-2 pb-4">
      {blocks.length === 0 ? <p className="p-4 text-center text-xs text-slate-400">Aucun bloc pour l’instant.</p> : <LayerList blocks={blocks} depth={0} />}
    </div>
  );
}

function LayerList({ blocks, depth }: { blocks: Block[]; depth: number }) {
  return (
    <ol>
      {blocks.map((b) => (b && typeof b === 'object' ? <LayerRow key={b.id} block={b} depth={depth} /> : null))}
    </ol>
  );
}

const LayerRow = memo(function LayerRow({ block, depth }: { block: Block; depth: number }) {
  const { ops, ui } = useBuilder();
  const active = useUi(ui, (s) => s.selectedId === block.id);
  const [open, setOpen] = useState(true);
  const Icon = BLOCK_ICONS[block.type] ?? LayoutGrid;
  const container = block.type === 'section' || block.type === 'columns';
  return (
    <li>
      <div
        className={cx('group flex items-center gap-1 rounded-md py-0.5 pr-1.5 transition-colors', active ? 'bg-brand-50' : 'hover:bg-slate-50')}
        style={{ paddingLeft: 4 + depth * 14 }}
        onMouseEnter={() => ui.set({ hoverId: block.id })}
        onMouseLeave={() => ui.set({ hoverId: null })}
      >
        <button type="button" onClick={() => setOpen((o) => !o)} className={cx('flex h-5 w-5 shrink-0 items-center justify-center rounded text-slate-400 hover:text-slate-700', !container && 'invisible')}>
          <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
        </button>
        <button type="button" onClick={() => ops.select(block.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <Icon size={14} className={cx('shrink-0', active ? 'text-brand-600' : 'text-slate-400')} />
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5 py-1">
            <span className={cx('shrink-0 text-xs font-medium', active ? 'text-brand-700' : 'text-slate-700')}>{BLOCK_LABELS[block.type]}</span>
            <span className="truncate text-[11px] text-slate-400">{blockSummary(block)}</span>
          </span>
        </button>
      </div>
      {container && open && block.type === 'section' && <LayerList blocks={block.children ?? []} depth={depth + 1} />}
      {container && open && block.type === 'columns' && (
        <ol>
          {(block.columns ?? []).map((c, i) => (
            <li key={c.id}>
              <div className="py-0.5 text-[11px] text-slate-400" style={{ paddingLeft: 30 + (depth + 1) * 14 }}>
                Colonne {i + 1} · {Math.round(c.width)}%
              </div>
              <LayerList blocks={c.children ?? []} depth={depth + 2} />
            </li>
          ))}
        </ol>
      )}
    </li>
  );
});

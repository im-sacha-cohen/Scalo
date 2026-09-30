import { memo, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ArrowUpLeft, Copy, Ellipsis, GripVertical, LayoutTemplate, MousePointerClick, Plus, Trash } from 'lucide-react';
import {
  BLOCK_LABELS,
  builderCss,
  columnsParts,
  renderBlock,
  sectionParts,
  type Block,
  type ColumnsBlock,
  type PageSettings,
  type SectionBlock,
} from '@scalo/shared';
import { cx } from '../components/ui';
import { DEVICE_WIDTHS, styleObject, useBuilder, type BuilderMode, type Device } from './context';
import { useUi } from './store';
import { BLOCK_ICONS } from './meta';

const EDITOR_CSS =
  builderCss('editor') +
  `.scalo-canvas .scalo-cols.scalo-cols-guides>.scalo-col{outline:1px dashed rgba(99,102,241,.35);outline-offset:-1px}` +
  `.scalo-canvas [contenteditable="true"]{outline:none;cursor:text;-webkit-user-select:text;user-select:text;caret-color:currentColor}` +
  `.scalo-canvas [data-edit]{cursor:text}`;

interface CanvasProps {
  blocks: Block[];
  settings: PageSettings;
  mode: BuilderMode;
  device: Device;
  zoom: number;
  onOpenTemplates: () => void;
}

export function Canvas({ blocks, settings, mode, device, zoom, onOpenTemplates }: CanvasProps) {
  const { ops, ui } = useBuilder();
  const selectedId = useUi(ui, (s) => s.selectedId);
  const scrollRef = useRef<HTMLDivElement>(null);

  // keep the selection visible (selection from the layers panel, keyboard moves...)
  useEffect(() => {
    if (!selectedId) return;
    const el = scrollRef.current?.querySelector(`[data-builder-block="${window.CSS.escape(selectedId)}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const c = scrollRef.current!.getBoundingClientRect();
    if (r.top < c.top || r.top > c.bottom - 40) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedId]);

  const preventLinks = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('a, summary')) e.preventDefault();
  };

  const width = DEVICE_WIDTHS[device];
  const isEmail = mode === 'email';
  const framed = device !== 'desktop';

  return (
    <div
      ref={scrollRef}
      data-canvas-scroll=""
      className="scalo-scroll relative flex-1 overflow-auto bg-slate-100 select-none"
      onClick={() => ops.select(null)}
      onMouseLeave={() => ui.set({ hoverId: null })}
    >
      <style>{EDITOR_CSS}</style>
      <div className={cx('flex min-h-full justify-center', framed ? 'px-6 py-8' : 'p-0')}>
        <div
          className={cx('relative shrink-0 transition-[width] duration-300', framed && 'rounded-[34px] border-[10px] border-slate-900 bg-slate-900 shadow-xl')}
          style={{ width: width ? width + 20 : '100%', zoom: zoom / 100 }}
        >
          <div
            data-canvas-frame=""
            onClickCapture={preventLinks}
            className="scalo-canvas relative overflow-hidden"
            style={{
              containerType: 'inline-size',
              containerName: 'scalo',
              background: settings.background,
              fontFamily: settings.fontFamily,
              color: settings.textColor,
              borderRadius: framed ? 24 : 0,
              minHeight: framed ? (device === 'mobile' ? 780 : 900) : 'calc(100vh - 56px)',
              padding: isEmail ? '24px 12px' : 0,
              textAlign: 'left',
              lineHeight: 1.5,
            }}
          >
            <div
              data-list-key="root"
              style={{
                maxWidth: settings.maxWidth,
                margin: '0 auto',
                background: settings.contentBackground,
                padding: `${settings.contentPadding ?? (isEmail ? 16 : 24)}px 0`,
                borderRadius: isEmail ? 8 : 0,
                minHeight: isEmail ? 280 : framed ? (device === 'mobile' ? 760 : 880) : 'calc(100vh - 56px)',
                position: 'relative',
              }}
            >
              <ListBody listKey="root" blocks={blocks} settings={settings} depth={0} inColumn={false} />
              {blocks.length === 0 && <EmptyRoot isEmail={isEmail} onOpenTemplates={onOpenTemplates} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------- lists ---------------- */

const ListBody = memo(function ListBody({
  listKey,
  blocks,
  settings,
  depth,
  inColumn,
}: {
  listKey: string;
  blocks: Block[];
  settings: PageSettings;
  depth: number;
  inColumn: boolean;
}) {
  const { ui, openQuickInsert } = useBuilder();
  const drop = useUi(ui, (s) => (s.drop && s.drop.list === listKey ? s.drop.index : -1));
  const dragId = useUi(ui, (s) => s.dragId);

  const out: ReactNode[] = [];
  let k = 0;
  blocks.forEach((b, i) => {
    if (!b || typeof b !== 'object') return;
    if (b.id !== dragId) {
      if (drop === k) out.push(<DropLine key="__drop" />);
      k++;
    }
    out.push(<BlockNode key={b.id} block={b} list={listKey} index={i} count={blocks.length} settings={settings} depth={depth} inColumn={inColumn} />);
  });
  if (drop === k && (blocks.length > 0 || listKey === 'root')) out.push(<DropLine key="__drop" />);
  if (blocks.length === 0 && listKey !== 'root') {
    out.push(
      <div
        key="__empty"
        className={cx(
          'm-1 flex min-h-[72px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-xs font-medium transition-colors',
          drop === 0 ? 'border-brand-500 bg-brand-50 text-brand-700' : 'border-slate-300/70 text-slate-400',
        )}
        style={{ fontFamily: 'var(--font-sans)' }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openQuickInsert({ list: listKey, index: 0 }, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          className="flex h-6 w-6 items-center justify-center rounded-full bg-white text-slate-500 shadow-sm ring-1 ring-slate-200 hover:bg-brand-600 hover:text-white hover:ring-brand-600"
          title="Ajouter un bloc"
        >
          <Plus size={15} />
        </button>
        {drop === 0 ? 'Déposer ici' : 'Vide'}
      </div>,
    );
  }
  return <>{out}</>;
});

function DropLine() {
  return (
    <div className="pointer-events-none relative z-40 h-0">
      <div className="absolute inset-x-2 -top-[2px] h-1 rounded-full bg-brand-500 shadow-[0_0_0_3px_rgba(99,102,241,0.18)]" />
    </div>
  );
}

function EmptyRoot({ isEmail, onOpenTemplates }: { isEmail: boolean; onOpenTemplates: () => void }) {
  const { ui, openQuickInsert } = useBuilder();
  const dragging = useUi(ui, (s) => s.drop !== null);
  return (
    <div
      className={cx(
        'mx-6 my-4 flex flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-16 text-center transition-colors',
        dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300',
      )}
      style={{ fontFamily: 'var(--font-sans)' }}
    >
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-500">
        {dragging ? <Plus size={24} /> : <MousePointerClick size={24} />}
      </span>
      <p className="text-sm font-semibold text-slate-800">{dragging ? 'Relâchez pour ajouter' : `${isEmail ? 'Cet email' : 'Cette page'} est vide`}</p>
      <p className="mt-1 max-w-sm text-sm text-slate-500">Partez d’un modèle, ou ajoutez des blocs depuis le panneau « Ajouter ».</p>
      <div className="mt-5 flex gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenTemplates();
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-brand-700"
        >
          <LayoutTemplate size={16} /> Choisir un modèle
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            openQuickInsert({ list: 'root', index: 0 }, (e.currentTarget as HTMLElement).getBoundingClientRect());
          }}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <Plus size={16} /> Ajouter un bloc
        </button>
      </div>
    </div>
  );
}

/* ---------------- blocks ---------------- */

const LeafHtml = memo(function LeafHtml({ html }: { html: string }) {
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
});

const KIND_COLORS = {
  leaf: { ring: 'var(--color-brand-500)', hover: 'rgb(99 102 241 / 0.45)' },
  section: { ring: 'var(--color-brand-500)', hover: 'rgb(99 102 241 / 0.3)' },
  columns: { ring: 'var(--color-brand-500)', hover: 'rgb(99 102 241 / 0.3)' },
};

const BlockNode = memo(function BlockNode({
  block,
  list,
  index,
  settings,
  depth,
  inColumn,
}: {
  block: Block;
  list: string;
  index: number;
  count?: number;
  settings: PageSettings;
  depth: number;
  inColumn: boolean;
}) {
  const { ops, ui, openQuickInsert, openContextMenu, startInlineEdit } = useBuilder();
  const selected = useUi(ui, (s) => s.selectedId === block.id);
  const hovered = useUi(ui, (s) => s.hoverId === block.id && !s.dragId);
  const editing = useUi(ui, (s) => s.editing?.blockId === block.id);
  const dragging = useUi(ui, (s) => s.dragId === block.id);
  const anyDrag = useUi(ui, (s) => s.dragId !== null || s.drop !== null);
  const isContainer = block.type === 'section' || block.type === 'columns';
  const kind = block.type === 'section' ? 'section' : block.type === 'columns' ? 'columns' : 'leaf';
  const colors = KIND_COLORS[kind];
  const { attributes, listeners, setNodeRef } = useDraggable({ id: block.id, data: { from: 'canvas' }, disabled: editing });
  const Icon = BLOCK_ICONS[block.type] ?? BLOCK_ICONS.text;
  const first = index === 0;
  const topLevel = depth === 0;

  const ctx = useMemo(() => ({ mode: 'editor' as const, settings, depth, inColumn }), [settings, depth, inColumn]);
  const html = useMemo(() => (isContainer ? '' : renderBlock(block, ctx)), [block, ctx, isContainer]);

  let body: ReactNode;
  if (block.type === 'section') body = <SectionView block={block} settings={settings} depth={depth} ctx={ctx} />;
  else if (block.type === 'columns') body = <ColumnsView block={block} settings={settings} depth={depth} ctx={ctx} guides={selected || hovered || anyDrag} />;
  else body = <LeafHtml html={html} />;

  const stop = (fn: () => void) => (e: ReactMouseEvent) => {
    e.stopPropagation();
    fn();
  };

  const labelInside = first || isContainer;

  return (
    <div
      ref={setNodeRef}
      data-builder-block={block.id}
      {...(isContainer || editing ? {} : listeners)}
      onClick={(e) => {
        e.stopPropagation();
        if (!editing) ops.select(block.id);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (isContainer) return;
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-edit]');
        if (el && e.currentTarget.contains(el)) startInlineEdit(block.id, block.type, el.dataset.edit!, el, e.clientX, e.clientY);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        ops.select(block.id);
        openContextMenu(block.id, e.clientX, e.clientY);
      }}
      onMouseOver={(e) => {
        e.stopPropagation();
        if (ui.get().hoverId !== block.id) ui.set({ hoverId: block.id });
      }}
      className={cx('relative outline-none', !isContainer && !editing && 'cursor-pointer')}
      style={{ opacity: dragging ? 0.35 : 1, zIndex: selected ? 5 : undefined }}
    >
      {body}

      {/* outline */}
      <div
        className="pointer-events-none absolute inset-0 z-20"
        style={{ boxShadow: selected ? `inset 0 0 0 1.5px ${colors.ring}` : hovered ? `inset 0 0 0 1px ${colors.hover}` : undefined }}
      />

      {/* type label (acts as drag handle for containers) */}
      {selected && !editing && !anyDrag && (
        <div
          {...(isContainer ? listeners : {})}
          {...(isContainer ? attributes : {})}
          role={undefined}
          tabIndex={undefined}
          onClick={(e) => {
            e.stopPropagation();
            ops.select(block.id);
          }}
          className={cx(
            'absolute left-0 z-30 flex items-center gap-1 bg-brand-500 px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap text-white',
            labelInside ? 'top-0 rounded-br-md' : '-top-[20px] rounded-t-md',
            isContainer ? 'cursor-grab active:cursor-grabbing' : 'pointer-events-none',
          )}
          style={{ fontFamily: 'var(--font-sans)', lineHeight: '16px' }}
          title={isContainer ? 'Glisser pour déplacer' : undefined}
        >
          {isContainer && <GripVertical size={11} className="opacity-70" />}
          <Icon size={12} />
          {BLOCK_LABELS[block.type]}
          {block.style?.hideOnMobile && <span className="opacity-75">· masqué mobile</span>}
          {block.style?.hideOnDesktop && <span className="opacity-75">· masqué ordinateur</span>}
        </div>
      )}

      {/* floating toolbar */}
      {selected && !editing && !anyDrag && (
        <div
          className={cx('absolute right-1 z-30 flex animate-fade-in items-center rounded-lg bg-white p-0.5 text-slate-600 shadow-float', labelInside ? 'top-1' : '-top-[34px]')}
          style={{ fontFamily: 'var(--font-sans)' }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <span
            {...listeners}
            {...attributes}
            role={undefined}
            className="flex h-7 w-6 cursor-grab items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing"
            title="Glisser pour déplacer"
          >
            <GripVertical size={14} />
          </span>
          {!topLevel && (
            <ToolBtn label="Sélectionner le parent" onClick={stop(() => selectParent(block.id))}>
              <ArrowUpLeft size={14} />
            </ToolBtn>
          )}
          <ToolBtn label="Dupliquer (Ctrl+D)" onClick={stop(() => ops.duplicate(block.id))}>
            <Copy size={14} />
          </ToolBtn>
          <ToolBtn
            label="Plus d’actions (monter, descendre, copier…)"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openContextMenu(block.id, r.left, r.bottom + 4);
            }}
          >
            <Ellipsis size={14} />
          </ToolBtn>
          <ToolBtn label="Supprimer (Suppr)" danger onClick={stop(() => ops.remove(block.id))}>
            <Trash size={14} />
          </ToolBtn>
        </div>
      )}

      {/* "+" insert buttons */}
      {hovered && !editing && !anyDrag && (
        <>
          {first && <InsertDot position="top" onClick={(r) => openQuickInsert({ list, index }, r)} />}
          <InsertDot position="bottom" onClick={(r) => openQuickInsert({ list, index: index + 1 }, r)} />
        </>
      )}
    </div>
  );

  function selectParent(id: string) {
    const el = document.querySelector(`[data-builder-block="${window.CSS.escape(id)}"]`);
    const parent = el?.parentElement?.closest<HTMLElement>('[data-builder-block]');
    if (parent?.dataset.builderBlock) ops.select(parent.dataset.builderBlock);
  }
});

function InsertDot({ position, onClick }: { position: 'top' | 'bottom'; onClick: (r: DOMRect) => void }) {
  return (
    <button
      type="button"
      title="Insérer un bloc ici"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick((e.currentTarget as HTMLElement).getBoundingClientRect());
      }}
      className={cx(
        'absolute left-1/2 z-30 flex h-5 w-5 -translate-x-1/2 animate-fade-in items-center justify-center rounded-full bg-white text-brand-600 shadow-float transition-all hover:scale-110 hover:bg-brand-600 hover:text-white',
        position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2',
      )}
    >
      <Plus size={13} strokeWidth={2.5} />
    </button>
  );
}

type EditorCtx = { mode: 'editor'; settings: PageSettings; depth: number; inColumn: boolean };

const SectionView = memo(function SectionView({ block, settings, depth, ctx }: { block: SectionBlock; settings: PageSettings; depth: number; ctx: EditorCtx }) {
  const parts = useMemo(() => sectionParts(block, ctx, depth === 0), [block, ctx, depth]);
  const outer = useMemo(() => styleObject(parts.outer), [parts]);
  const inner = useMemo(() => styleObject(parts.inner), [parts]);
  const overlay = useMemo(() => (parts.overlay ? styleObject(parts.overlay) : null), [parts]);
  return (
    <section className={parts.cls.join(' ')} style={outer}>
      {overlay && <div style={overlay} />}
      <div data-list-key={`s:${block.id}`} style={{ ...inner, minHeight: 40 }}>
        <ListBody listKey={`s:${block.id}`} blocks={Array.isArray(block.children) ? block.children : []} settings={settings} depth={depth + 1} inColumn={false} />
      </div>
    </section>
  );
});

const ColumnsView = memo(function ColumnsView({ block, settings, depth, ctx, guides }: { block: ColumnsBlock; settings: PageSettings; depth: number; ctx: EditorCtx; guides: boolean }) {
  const parts = useMemo(() => columnsParts(block, ctx), [block, ctx]);
  const outer = useMemo(() => styleObject(parts.outer), [parts]);
  const cols = Array.isArray(block.columns) ? block.columns : [];
  return (
    <div className={cx(parts.cls.join(' '), guides && 'scalo-cols-guides')} style={outer}>
      {cols.map((c, i) => (
        <div key={c.id} className="scalo-col" data-list-key={`c:${c.id}`} style={{ ...styleObject(parts.cols[i]?.style ?? ''), minHeight: 60 }}>
          <ListBody listKey={`c:${c.id}`} blocks={Array.isArray(c.children) ? c.children : []} settings={settings} depth={depth + 1} inColumn />
        </div>
      ))}
    </div>
  );
});

function ToolBtn({ label, onClick, disabled, danger, children }: { label: string; onClick: (e: ReactMouseEvent) => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={onClick}
      className={cx(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors disabled:opacity-30',
        danger ? 'text-slate-500 hover:bg-rose-50 hover:text-rose-600' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
      )}
    >
      {children}
    </button>
  );
}

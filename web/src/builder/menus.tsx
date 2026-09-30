import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, BookmarkPlus, ClipboardPaste, Copy, CopyPlus, Scissors, Square, SquareDashed, Trash } from 'lucide-react';
import {
  BLOCK_LABELS,
  EMAIL_BLOCK_TYPES,
  PAGE_BLOCK_TYPES,
  SECTION_TEMPLATES,
  buildSection,
  createBlock,
  createColumns,
  findBlock,
  getList,
  type Block,
} from '@scalo/shared';
import { cx } from '../components/ui';
import { useBuilder, type BuilderMode } from './context';
import { BLOCK_ICONS } from './meta';
import { hasClipboard } from './store';

/** Keeps a floating panel inside the viewport. */
function usePlacement(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  return { ref, pos };
}

function useDismiss(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', onClose);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', onClose);
    };
  }, [ref, onClose]);
}

/* ---------------- context menu ---------------- */

export function ContextMenu({ id, x, y, onClose }: { id: string; x: number; y: number; onClose: () => void }) {
  const { ops, getContent, mode } = useBuilder();
  const { ref, pos } = usePlacement(x, y);
  useDismiss(ref, onClose);
  const loc = findBlock(getContent().blocks ?? [], id);
  if (!loc) return null;
  const list = getList(getContent().blocks ?? [], loc.list) ?? [];
  const b = loc.block;
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };
  const canPaste = hasClipboard();

  return createPortal(
    <div
      ref={ref}
      role="menu"
      className="fixed z-[90] w-60 animate-pop-in rounded-xl bg-white p-1 text-sm text-slate-700 shadow-pop"
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-slate-400">{BLOCK_LABELS[b.type]}</div>
      <Item icon={CopyPlus} label="Dupliquer" kbd="Ctrl+D" onClick={run(() => ops.duplicate(id))} />
      <Item icon={Copy} label="Copier" kbd="Ctrl+C" onClick={run(() => ops.copy(id))} />
      <Item icon={Scissors} label="Couper" kbd="Ctrl+X" onClick={run(() => ops.cut(id))} />
      <Item icon={ClipboardPaste} label="Coller après" kbd="Ctrl+V" disabled={!canPaste} onClick={run(() => ops.paste({ list: loc.list, index: loc.index + 1 }))} />
      {b.type === 'section' && <Item icon={ClipboardPaste} label="Coller dans la section" disabled={!canPaste} onClick={run(() => ops.paste({ list: `s:${b.id}`, index: b.children?.length ?? 0 }))} />}
      <Sep />
      <Item icon={ArrowUp} label="Monter" kbd="Alt+↑" disabled={loc.index === 0} onClick={run(() => ops.move(id, -1))} />
      <Item icon={ArrowDown} label="Descendre" kbd="Alt+↓" disabled={loc.index >= list.length - 1} onClick={run(() => ops.move(id, 1))} />
      <Sep />
      {b.type !== 'section' && <Item icon={Square} label="Envelopper dans une section" onClick={run(() => ops.wrapInSection(id))} />}
      {b.type === 'section' && <Item icon={SquareDashed} label="Retirer la section (garder le contenu)" onClick={run(() => ops.unwrapSection(id))} />}
      <Item icon={BookmarkPlus} label={`Enregistrer comme modèle${mode === 'email' ? ' (email)' : ''}`} onClick={run(() => ops.saveAsSection(id))} />
      <Sep />
      <Item icon={Trash} label="Supprimer" kbd="Suppr" danger onClick={run(() => ops.remove(id))} />
    </div>,
    document.body,
  );
}

function Item({ icon: Icon, label, kbd, onClick, disabled, danger }: { icon: React.ComponentType<{ size?: number; className?: string }>; label: string; kbd?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors disabled:opacity-40 disabled:hover:bg-transparent',
        danger ? 'text-rose-600 hover:bg-rose-50' : 'hover:bg-slate-100',
      )}
    >
      <Icon size={15} className={danger ? undefined : 'text-slate-500'} />
      <span className="flex-1">{label}</span>
      {kbd && <span className="text-[11px] text-slate-400">{kbd}</span>}
    </button>
  );
}
const Sep = () => <div className="my-1 h-px bg-slate-100" />;

/* ---------------- quick insert ("+" buttons) ---------------- */

export function QuickInsert({ mode, anchor, accent, onClose, onInsert }: { mode: BuilderMode; anchor: DOMRect; accent: string; onClose: () => void; onInsert: (b: Block[]) => void }) {
  const [tab, setTab] = useState<'blocks' | 'sections'>('blocks');
  const { ref, pos } = usePlacement(anchor.left + anchor.width / 2 - 170, anchor.bottom + 8);
  useDismiss(ref, onClose);
  const types = mode === 'email' ? EMAIL_BLOCK_TYPES : PAGE_BLOCK_TYPES;
  const sections = SECTION_TEMPLATES.filter((s) => s.modes.includes(mode));
  const pick = (b: Block) => {
    onClose();
    onInsert([b]);
  };
  return createPortal(
    <div ref={ref} className="fixed z-[90] w-[340px] animate-pop-in rounded-xl bg-white shadow-pop" style={{ left: pos.left, top: pos.top }}>
      <div className="m-1.5 flex gap-0.5 rounded-lg bg-slate-100 p-0.5">
        {(['blocks', 'sections'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cx('h-7 flex-1 rounded-md text-xs font-medium', tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
          >
            {t === 'blocks' ? 'Blocs' : 'Sections prêtes'}
          </button>
        ))}
      </div>
      <div className="scalo-scroll max-h-[340px] overflow-y-auto p-2">
        {tab === 'blocks' ? (
          <div className="grid grid-cols-4 gap-1">
            {types.map((t) => {
              const Icon = BLOCK_ICONS[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => pick(t === 'columns' ? createColumns([50, 50]) : createBlock(t))}
                  className="flex flex-col items-center gap-1 rounded-lg px-1 py-2 text-[11px] leading-tight text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  <Icon size={17} strokeWidth={1.85} className="text-slate-400" />
                  <span className="text-center">{BLOCK_LABELS[t]}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-0.5">
            {sections.map((s) => (
              <button key={s.id} type="button" onClick={() => pick(buildSection(s, mode, accent))} className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 hover:text-slate-900">
                {s.name}
                <span className="text-[11px] text-slate-400">{s.category}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function MenuHint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-[11px] text-slate-400">{children}</p>;
}

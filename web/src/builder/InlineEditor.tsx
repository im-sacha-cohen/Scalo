// Inline (on-canvas) text editing: double-click an element carrying `data-edit` → contentEditable
// with a floating formatting toolbar. The value is sanitized when the edit is committed.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { findBlock, getPath, normalizeRich, type BlockType, type PageContent } from '@scalo/shared';
import type { BuilderOps } from './context';
import type { UiStore } from './store';
import { isRichField } from './meta';
import { exec, pastePlain, RichToolbar } from './rich';

interface Session {
  el: HTMLElement;
  blockId: string;
  field: string;
  rich: boolean;
  enterCommits: boolean;
  original: string;
  cleanup: () => void;
}

function caretFromPoint(x: number, y: number): Range | null {
  const d = document as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  if (typeof document.caretRangeFromPoint === 'function') return document.caretRangeFromPoint(x, y);
  const p = d.caretPositionFromPoint?.(x, y);
  if (!p) return null;
  const r = document.createRange();
  r.setStart(p.offsetNode, p.offset);
  r.collapse(true);
  return r;
}

export function useInlineEditor(ops: BuilderOps, ui: UiStore, getContent: () => PageContent) {
  const session = useRef<Session | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ el: HTMLElement; rich: boolean } | null>(null);

  const finish = useCallback(
    (commit: boolean) => {
      const s = session.current;
      if (!s) return;
      session.current = null;
      s.cleanup();
      const el = s.el;
      const value = s.rich ? normalizeRich(el.innerHTML) : (el.textContent ?? '').replace(/ /g, ' ').trim();
      el.removeAttribute('contenteditable');
      ui.set({ editing: null });
      setActive(null);
      const block = findBlock(getContent().blocks, s.blockId)?.block;
      const current = block ? getPath(block, s.field) : undefined;
      if (commit && block && value !== current && !(value === '' && current === undefined)) {
        ops.setField(s.blockId, s.field, value);
      } else {
        el.innerHTML = s.original;
      }
    },
    [ops, ui, getContent],
  );

  const start = useCallback(
    (blockId: string, type: BlockType, field: string, el: HTMLElement, x: number, y: number) => {
      if (session.current?.el === el) return;
      if (session.current) finish(true);
      const rich = isRichField(type, field);
      const multiline = rich && !(type === 'heading' || type === 'button' || type === 'list' || /^features\./.test(field));
      const original = el.innerHTML;
      el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
      el.focus({ preventScroll: true });
      const sel = window.getSelection();
      const hasSelection = sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode);
      if (!hasSelection) {
        const r = caretFromPoint(x, y);
        if (r && el.contains(r.startContainer)) {
          sel?.removeAllRanges();
          sel?.addRange(r);
        }
      }

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (multiline && !e.metaKey && !e.ctrlKey) exec('insertLineBreak');
          else if (!multiline && e.shiftKey && rich) exec('insertLineBreak');
          else finish(true);
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          finish(true); // then let the page save shortcut run
          return;
        }
        e.stopPropagation(); // native undo/redo and text keys stay inside the editable element
      };
      const onPaste = (e: ClipboardEvent) => pastePlain(e);
      const onBlur = () => {
        setTimeout(() => {
          const s = session.current;
          if (!s || s.el !== el) return;
          const a = document.activeElement;
          if (a && (el.contains(a) || toolbarRef.current?.contains(a))) return;
          finish(true);
        }, 0);
      };
      const onDrop = (e: DragEvent) => e.preventDefault(); // no foreign HTML dropped into the editor
      el.addEventListener('keydown', onKey);
      el.addEventListener('paste', onPaste);
      el.addEventListener('drop', onDrop);
      el.addEventListener('blur', onBlur);
      session.current = {
        el,
        blockId,
        field,
        rich,
        enterCommits: !multiline,
        original,
        cleanup: () => {
          el.removeEventListener('keydown', onKey);
          el.removeEventListener('paste', onPaste);
          el.removeEventListener('drop', onDrop);
          el.removeEventListener('blur', onBlur);
        },
      };
      ui.set({ editing: { blockId, field, rich }, selectedId: blockId });
      setActive({ el, rich });
    },
    [finish, ui],
  );

  // commit when the component unmounts (leaving the editor)
  useEffect(() => () => finish(true), [finish]);

  const overlay = active ? <FloatingToolbar el={active.el} rich={active.rich} toolbarRef={toolbarRef} onDone={() => finish(true)} /> : null;
  return { start, finish, overlay, isEditing: () => !!session.current };
}

function FloatingToolbar({ el, rich, toolbarRef, onDone }: { el: HTMLElement; rich: boolean; toolbarRef: React.RefObject<HTMLDivElement | null>; onDone: () => void }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const w = toolbarRef.current?.offsetWidth ?? 360;
        const top = r.top > 64 ? r.top - 46 : r.bottom + 8;
        const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
        setPos({ top, left });
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    el.addEventListener('input', update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      el.removeEventListener('input', update);
    };
  }, [el, toolbarRef]);

  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-[70] flex animate-fade-in items-center gap-0.5 rounded-xl bg-slate-900 p-1 text-white shadow-pop"
      style={{ top: pos?.top ?? -999, left: pos?.left ?? -999, fontFamily: 'Inter, sans-serif' }}
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onBlur={() =>
        setTimeout(() => {
          const a = document.activeElement;
          if (a && (el.contains(a) || toolbarRef.current?.contains(a))) return;
          if (el.isConnected && el.getAttribute('contenteditable') === 'true') onDone();
        }, 0)
      }
    >
      {rich ? <RichToolbar dark /> : <span className="px-2 text-xs text-slate-300">Texte simple</span>}
      <span className="mx-0.5 h-4 w-px bg-white/15" />
      <button type="button" onClick={onDone} className="flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-emerald-300 hover:bg-white/10" title="Terminer (Entrée / clic en dehors)">
        <Check size={14} /> OK
      </button>
    </div>,
    document.body,
  );
}

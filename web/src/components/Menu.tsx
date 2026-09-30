import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { LucideIcon } from 'lucide-react';
import { cx } from './ui';

export type MenuEntry =
  | { label: ReactNode; description?: ReactNode; icon?: LucideIcon; onClick: () => void; kbd?: string; danger?: boolean; disabled?: boolean; checked?: boolean }
  | 'sep'
  | { heading: ReactNode };

/**
 * Dropdown menu anchored to a trigger (rendered in a portal so it is never clipped by a scrolling panel).
 * `trigger` receives the open state and the toggle handler.
 */
export function DropdownMenu({
  trigger,
  items,
  align = 'end',
  width = 240,
  className,
}: {
  trigger: (p: { open: boolean; toggle: () => void; ref: (el: HTMLElement | null) => void }) => ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'end';
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const setAnchor = (el: HTMLElement | null) => {
    anchor.current = el;
  };

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = panel.current?.offsetHeight ?? 0;
    let left = align === 'end' ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    let top = r.bottom + 6;
    if (h && top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    setPos({ left, top });
  }, [open, align, width]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', () => setOpen(false), { once: true });
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);

  return (
    <>
      {trigger({ open, toggle: () => setOpen((o) => !o), ref: setAnchor })}
      {open &&
        createPortal(
          <div
            ref={panel}
            role="menu"
            className={cx('fixed z-[95] animate-pop-in rounded-xl bg-white p-1 text-sm text-slate-700 shadow-pop', className)}
            style={{ width, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          >
            {items.map((it, i) =>
              it === 'sep' ? (
                <div key={i} className="my-1 h-px bg-slate-100" />
              ) : 'heading' in it ? (
                <div key={i} className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-slate-400">
                  {it.heading}
                </div>
              ) : (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    setOpen(false);
                    it.onClick();
                  }}
                  className={cx(
                    'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors disabled:opacity-40 disabled:hover:bg-transparent',
                    it.danger ? 'text-rose-600 hover:bg-rose-50' : 'hover:bg-slate-100',
                  )}
                >
                  {it.icon && <it.icon size={15} className={cx('mt-0.5 shrink-0', it.danger ? '' : 'text-slate-500')} />}
                  <span className="min-w-0 flex-1">
                    <span className="block">{it.label}</span>
                    {it.description && <span className="block text-xs text-slate-400">{it.description}</span>}
                  </span>
                  {it.kbd && <span className="mt-0.5 text-[11px] text-slate-400">{it.kbd}</span>}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

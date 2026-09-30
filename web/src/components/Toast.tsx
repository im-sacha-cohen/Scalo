import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';
import { cx } from './ui';

type Kind = 'success' | 'error' | 'info';
interface ToastItem { id: number; kind: Kind; message: string }
interface ToastApi {
  success: (m: string) => void;
  error: (m: string | unknown) => void;
  info: (m: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (kind: Kind, message: string) => {
      const id = ++seq.current;
      setItems((l) => [...l.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      info: (m) => push('info', m),
      error: (m) => push('error', typeof m === 'string' ? m : m instanceof Error ? m.message : 'Une erreur est survenue'),
    }),
    [push],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed right-4 bottom-4 z-[200] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
          {items.map((t) => {
            const Icon = t.kind === 'success' ? CircleCheck : t.kind === 'error' ? CircleX : Info;
            return (
              <div
                key={t.id}
                role="status"
                className="pointer-events-auto flex animate-slide-in items-start gap-3 rounded-xl border border-slate-200 bg-white p-3.5 pr-2.5 shadow-pop"
              >
                <Icon
                  size={20}
                  className={cx('mt-px shrink-0', t.kind === 'success' ? 'text-emerald-500' : t.kind === 'error' ? 'text-rose-500' : 'text-brand-500')}
                />
                <p className="min-w-0 flex-1 text-sm text-slate-700">{t.message}</p>
                <button onClick={() => dismiss(t.id)} className="rounded-md p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Fermer">
                  <X size={16} />
                </button>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c;
}

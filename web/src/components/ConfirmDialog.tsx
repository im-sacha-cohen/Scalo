import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { TriangleAlert, Send } from 'lucide-react';
import { Modal } from './Modal';
import { Button, cx } from './ui';

export interface ConfirmOptions {
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
}

type ConfirmFn = (o: ConfirmOptions) => Promise<boolean>;
const Ctx = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        resolver.current?.(false);
        resolver.current = resolve;
        setOpts(o);
      }),
    [],
  );

  const close = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  const tone = opts?.tone ?? 'danger';
  return (
    <Ctx.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        onClose={() => close(false)}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              {opts?.cancelLabel ?? 'Annuler'}
            </Button>
            <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={() => close(true)} data-autofocus>
              {opts?.confirmLabel ?? 'Confirmer'}
            </Button>
          </>
        }
      >
        <div className="flex gap-4">
          <span
            className={cx(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
              tone === 'danger' ? 'bg-rose-100 text-rose-600' : 'bg-brand-100 text-brand-600',
            )}
          >
            {tone === 'danger' ? <TriangleAlert size={20} /> : <Send size={18} />}
          </span>
          <div className="min-w-0 pt-1">
            <h3 className="text-base font-semibold text-slate-900">{opts?.title}</h3>
            {opts?.message && <div className="mt-1.5 text-sm text-slate-600">{opts.message}</div>}
          </div>
        </div>
      </Modal>
    </Ctx.Provider>
  );
}

export function useConfirm() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return c;
}

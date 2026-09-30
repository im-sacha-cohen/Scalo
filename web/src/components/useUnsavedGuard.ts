import { useEffect, useRef, type RefObject } from 'react';
import { useBlocker } from 'react-router';
import { useConfirm } from './ConfirmDialog';

/**
 * Asks for confirmation before leaving the current route (in-app navigation) while `dirty`.
 * `bypass` lets the page navigate on purpose right after saving (state may not have re-rendered yet).
 */
export function useUnsavedGuard(dirty: boolean, bypass?: RefObject<boolean>) {
  const confirm = useConfirm();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && !bypass?.current && currentLocation.pathname !== nextLocation.pathname,
  );

  const ref = useRef(blocker);
  ref.current = blocker;

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    let alive = true;
    confirm({
      title: 'Quitter sans enregistrer ?',
      message: 'Vos modifications non enregistrées seront perdues.',
      confirmLabel: 'Quitter',
      cancelLabel: 'Rester',
    }).then((ok) => {
      if (!alive) return;
      if (ok) ref.current.proceed?.();
      else ref.current.reset?.();
    });
    return () => {
      alive = false;
    };
  }, [blocker.state, confirm]);
}

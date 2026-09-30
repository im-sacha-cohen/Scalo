import { useCallback, useEffect, useRef, useState } from 'react';

export function useDebounced<T>(value: T, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/** Loads data with a fetcher; `reload()` re-runs it. Keeps previous data while reloading. */
export function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;

  const reload = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const d = await fetchRef.current();
      if (id === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, setData, error, loading, reload };
}

/** Warns before closing the tab when `when` is true. */
export function useBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [when]);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/**
 * Calls `fn` every `ms` while `enabled` and the browser tab is visible (document.visibilityState).
 * Runs once immediately when (re)enabled or when the tab becomes visible again. Stops on unmount.
 * Ticks never overlap: the next one is scheduled after the previous call settles.
 */
export function usePolling(fn: () => unknown, ms: number, enabled = true) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;
    let running = false;
    const tick = async () => {
      if (!alive || running) return;
      clearTimeout(timer);
      if (document.visibilityState !== 'visible') return; // resumed by visibilitychange
      running = true;
      try {
        await fnRef.current();
      } catch {
        /* polling errors are surfaced by the caller */
      } finally {
        running = false;
      }
      if (alive) timer = setTimeout(tick, ms);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
      else clearTimeout(timer);
    };
    document.addEventListener('visibilitychange', onVisibility);
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, enabled]);
}

/** Current time, refreshed every `ms` (for countdowns). */
export function useNow(ms = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

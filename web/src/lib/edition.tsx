// Edition of the instance (community / Enterprise), role of the signed-in person and admin branding.
// Core, neutral: in the community edition the API answers `community` / `owner` and nothing changes on screen.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountRole, EditionInfo } from '@scalo/shared';
import { request } from './api';
import { useAuth } from './auth';

interface EditionState {
  info: EditionInfo | null;
  role: AccountRole;
  /** Enterprise features usable right now. */
  has: (feature: string) => boolean;
  /** Owner or administrator of the account. */
  isAdmin: boolean;
  reload: () => Promise<void>;
}

const EditionContext = createContext<EditionState>({ info: null, role: 'owner', has: () => false, isAdmin: true, reload: async () => undefined });

export function EditionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [info, setInfo] = useState<EditionInfo | null>(null);
  const userId = user?.id ?? null;

  const reload = useCallback(async () => {
    try {
      setInfo(await request<EditionInfo>('GET', '/edition'));
    } catch {
      setInfo(null); // older API or transient error: behave like the community edition
    }
  }, []);

  useEffect(() => {
    if (userId === null) setInfo(null);
    else void reload();
  }, [userId, reload]);

  const value = useMemo<EditionState>(() => {
    const role = info?.role ?? 'owner';
    return { info, role, has: (f) => !!info?.features.includes(f), isAdmin: role === 'owner' || role === 'admin', reload };
  }, [info, reload]);
  return <EditionContext.Provider value={value}>{children}</EditionContext.Provider>;
}

export const useEdition = () => useContext(EditionContext);

// Small external stores for high-frequency editor UI state (selection, hover, drop target, inline editing).
// Components subscribe with selectors returning primitives, so only the affected blocks re-render.
import { useSyncExternalStore } from 'react';
import { adaptForEmail, cloneBlock, type Block } from '@scalo/shared';

export interface DropTarget {
  list: string;
  index: number; // index in the list without the dragged block
}

export interface EditingState {
  blockId: string;
  field: string;
  rich: boolean;
}

export interface UiState {
  selectedId: string | null;
  hoverId: string | null;
  drop: DropTarget | null;
  dragId: string | null;   // block being moved (canvas drag)
  editing: EditingState | null;
}

export function createUiStore() {
  let state: UiState = { selectedId: null, hoverId: null, drop: null, dragId: null, editing: null };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<UiState>) {
      let changed = false;
      for (const k of Object.keys(patch) as (keyof UiState)[]) {
        if (!Object.is(state[k], patch[k])) changed = true;
      }
      if (!changed) return;
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe(l: () => void) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
export type UiStore = ReturnType<typeof createUiStore>;

export function useUi<T>(store: UiStore, sel: (s: UiState) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}

// ---------- clipboard (cross-page / cross-tab via localStorage) ----------

const CLIP_KEY = 'scalo_builder_clipboard';

export function writeClipboard(block: Block) {
  try {
    localStorage.setItem(CLIP_KEY, JSON.stringify({ v: 1, block, at: Date.now() }));
  } catch {
    /* storage full / disabled */
  }
}

export function readClipboard(mode: 'page' | 'email'): Block | null {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { block?: Block };
    if (!data.block || typeof data.block !== 'object' || typeof data.block.type !== 'string') return null;
    const b = cloneBlock(data.block);
    if (mode === 'email') {
      if (['form', 'countdown', 'html'].includes(b.type)) return null;
      adaptForEmail([b]);
    }
    return b;
  } catch {
    return null;
  }
}

export const hasClipboard = () => {
  try {
    return !!localStorage.getItem(CLIP_KEY);
  } catch {
    return false;
  }
};

// ---------- personal saved sections ----------

export interface SavedSection {
  id: string;
  name: string;
  mode: 'page' | 'email';
  block: Block;
  created_at: string;
}

const SAVED_KEY = 'scalo_saved_sections';

export function loadSavedSections(): SavedSection[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const list = raw ? (JSON.parse(raw) as SavedSection[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && s.block && typeof s.name === 'string') : [];
  } catch {
    return [];
  }
}

export function storeSavedSections(list: SavedSection[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
    window.dispatchEvent(new Event('scalo-saved-sections'));
    return true;
  } catch {
    return false;
  }
}

import { createContext, useContext } from 'react';
import type { Block, BlockStyle, BlockType, PageContent, PageSettings } from '@scalo/shared';
import type { UiStore } from './store';

export type Device = 'desktop' | 'tablet' | 'mobile';
export type BuilderMode = 'page' | 'email';

export const DEVICE_WIDTHS: Record<Device, number | null> = { desktop: null, tablet: 768, mobile: 390 };

export interface InsertTarget {
  list: string;
  index: number;
}

/** Operations exposed to the canvas / inspector / panels. `key` coalesces rapid edits of the same field in one undo step. */
export interface BuilderOps {
  select: (id: string | null) => void;
  update: (id: string, patch: Partial<Block>, key?: string) => void;
  updateStyle: (id: string, patch: Partial<BlockStyle>, key?: string) => void;
  setField: (id: string, path: string, value: unknown, key?: string) => void;
  updateSettings: (patch: Partial<PageSettings>, key?: string) => void;
  replaceContent: (c: PageContent) => void;
  insertBlocks: (blocks: Block[], target?: InsertTarget) => void;
  insertType: (type: BlockType, target?: InsertTarget) => void;
  move: (id: string, dir: -1 | 1) => void;
  moveTo: (id: string, target: InsertTarget) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  copy: (id: string) => void;
  cut: (id: string) => void;
  paste: (target?: InsertTarget) => boolean;
  wrapInSection: (id: string) => void;
  unwrapSection: (id: string) => void;
  saveAsSection: (id: string) => void;
  setColumnWidths: (id: string, widths: number[]) => void;
}

export interface BuilderApi {
  mode: BuilderMode;
  ops: BuilderOps;
  ui: UiStore;
  /** latest content (stable function) */
  getContent: () => PageContent;
  openMedia: (onPick: (url: string) => void) => void;
  openQuickInsert: (target: InsertTarget, anchor: DOMRect) => void;
  openContextMenu: (id: string, x: number, y: number) => void;
  startInlineEdit: (blockId: string, type: BlockType, field: string, el: HTMLElement, x: number, y: number) => void;
}

export const BuilderContext = createContext<BuilderApi | null>(null);

export function useBuilder(): BuilderApi {
  const v = useContext(BuilderContext);
  if (!v) throw new Error('useBuilder outside <Builder>');
  return v;
}

/** Parses an inline style string produced by the shared renderer into a React style object. */
export function styleObject(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const s = css
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  let depth = 0;
  let quote = '';
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i <= 0) continue;
    const prop = p.slice(0, i).trim();
    const val = p.slice(i + 1).trim();
    if (!prop || !val) continue;
    const key = prop.startsWith('--') ? prop : prop.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[key] = val;
  }
  return out;
}

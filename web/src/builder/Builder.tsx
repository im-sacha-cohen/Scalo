import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import {
  CircleHelp,
  Eye,
  Image as ImageIcon,
  Layers,
  LayoutTemplate,
  Minus,
  Monitor,
  PanelsTopLeft,
  Plus,
  Redo2,
  Settings2,
  SlidersHorizontal,
  Smartphone,
  Tablet,
  Undo2,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  BLOCK_LABELS,
  DEFAULT_EMAIL_SETTINGS,
  DEFAULT_SETTINGS,
  SECTION_TEMPLATES,
  adaptForEmail,
  buildSection,
  cloneBlock,
  createBlock,
  createColumns,
  findBlock,
  getList,
  googleFontsUrl,
  insertBlocks,
  isInside,
  listDepth,
  mapBlock,
  moveBlock,
  removeBlock,
  setPath,
  subtreeHeight,
  uid,
  type Block,
  type BlockStyle,
  type BlockType,
  type Campaign,
  type PageContent,
  type Tag,
} from '@scalo/shared';
import { api } from '../lib/api';
import { cx } from '../components/ui';
import { useToast } from '../components/Toast';
import { Canvas } from './Canvas';
import { AddPanel, LayersPanel, SectionsPanel } from './Palette';
import { Inspector, SettingsPanel } from './Inspector';
import { BLOCK_ICONS } from './meta';
import { BuilderContext, type BuilderApi, type BuilderMode, type BuilderOps, type Device, type InsertTarget } from './context';
import { createUiStore, loadSavedSections, readClipboard, storeSavedSections, useUi, writeClipboard, type DropTarget } from './store';
import { useInlineEditor } from './InlineEditor';
import { ContextMenu, QuickInsert } from './menus';
import { MediaLibrary } from './MediaLibrary';
import { TemplateGallery } from './TemplateGallery';
import { PreviewFrame } from './PreviewFrame';
import { ShortcutsDialog } from './Shortcuts';

export type { Device, BuilderMode } from './context';

export interface BuilderHandle {
  undo: () => void;
  redo: () => void;
  openTemplates: () => void;
  togglePreview: () => void;
  openPanel: (id: string) => void;
}

/** A panel added to the left rail by the host editor (e.g. the email sending settings). */
export interface BuilderPanel {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Rendered inside the builder context (useBuilder() is available). */
  render: () => ReactNode;
  /** Shows a small dot on the rail icon (e.g. something needs attention). */
  dot?: boolean;
}

export interface BarState {
  preview: boolean;
  togglePreview: () => void;
}

export interface BuilderProps {
  content: PageContent;
  onChange: (c: PageContent) => void;
  mode: BuilderMode;
  /** Title used by the in-editor preview. */
  title?: string;
  /** Left part of the top bar (back button, page switcher, subject…). */
  barStart?: ReactNode;
  /** Right part of the top bar (save state, preview, primary action…). */
  barEnd?: (s: BarState) => ReactNode;
  /** Extra panels of the left rail, shown before the page settings. */
  panels?: BuilderPanel[];
  ref?: Ref<BuilderHandle>;
  className?: string;
}

type PanelId = 'add' | 'sections' | 'layers' | 'settings' | string;
const PANEL_KEY = 'scalo_builder_panel';

const HISTORY_LIMIT = 150;
const MERGE_WINDOW = 900;
const MAX_NESTING = 6;
const ZOOMS = [50, 67, 75, 90, 100, 110, 125];

const isEditable = (el: EventTarget | null) =>
  el instanceof HTMLElement && !!el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]');

type DragItem = { kind: 'type'; type: BlockType } | { kind: 'section'; id: string } | { kind: 'saved'; id: string } | { kind: 'move'; id: string };

export function Builder({ content, onChange, mode, title, barStart, barEnd, panels = [], ref, className }: BuilderProps) {
  const toast = useToast();
  const [device, setDevice] = useState<Device>('desktop');
  const [zoom, setZoom] = useState(100);
  const [preview, setPreview] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const ui = useMemo(() => createUiStore(), []);
  const selectedId = useUi(ui, (s) => s.selectedId);

  // Below 1280 px the flyout and the inspector float over the canvas, so the page always stays visible.
  const wide = useMediaQuery('(min-width: 1280px)');
  // phones: the inspector becomes a bottom sheet so the top of the canvas stays visible
  const phone = useMediaQuery('(max-width: 639px)');
  const panelIds = useMemo(() => new Set<string>(['add', 'sections', 'layers', 'settings', ...panels.map((p) => p.id)]), [panels]);
  const [panel, setPanelState] = useState<PanelId | null>(() => {
    if (typeof window === 'undefined' || !window.matchMedia('(min-width: 1280px)').matches) return null;
    try {
      const v = localStorage.getItem(PANEL_KEY);
      if (v === 'none') return null;
      return v || 'add';
    } catch {
      return 'add';
    }
  });
  const activePanel = panel && panelIds.has(panel) ? panel : panel ? 'add' : null;
  const setPanel = useCallback(
    (p: PanelId | null) => {
      setPanelState(p);
      if (wide) {
        try {
          localStorage.setItem(PANEL_KEY, p ?? 'none');
        } catch {
          /* ignore */
        }
      }
    },
    [wide],
  );
  const [dragHide, setDragHide] = useState(false);
  // narrow screens: the inspector can be tucked away without losing the selection
  const [inspectorHidden, setInspectorHidden] = useState(false);
  useEffect(() => setInspectorHidden(false), [selectedId]);
  useEffect(() => {
    // narrow screens: both overlays would hide the page, the inspector wins (the layers panel stays, to navigate)
    if (!wide && selectedId) setPanelState((p) => (p === 'layers' && window.matchMedia('(min-width: 1024px)').matches ? p : null));
  }, [selectedId, wide]);

  const defaults = mode === 'email' ? DEFAULT_EMAIL_SETTINGS : DEFAULT_SETTINGS;
  const settings = useMemo(() => ({ ...defaults, ...content.settings }), [defaults, content.settings]);
  const blocks = useMemo(() => (Array.isArray(content.blocks) ? content.blocks : []), [content.blocks]);

  // Google Fonts used by the page, loaded in the editor too (WYSIWYG)
  const fontsUrl = mode === 'page' ? googleFontsUrl(settings) : null;
  useEffect(() => {
    if (!fontsUrl) return;
    const id = 'scalo-builder-fonts';
    let link = document.getElementById(id) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.href !== fontsUrl) link.href = fontsUrl;
  }, [fontsUrl]);

  // ---------- history ----------
  const contentRef = useRef(content);
  contentRef.current = content;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const past = useRef<PageContent[]>([]);
  const future = useRef<PageContent[]>([]);
  const lastKey = useRef<{ key: string; at: number } | null>(null);
  const [hist, setHist] = useState({ canUndo: false, canRedo: false });

  const syncHist = useCallback(() => {
    const s = { canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
    setHist((h) => (h.canUndo === s.canUndo && h.canRedo === s.canRedo ? h : s));
  }, []);

  const commit = useCallback(
    (next: PageContent, key?: string) => {
      const now = Date.now();
      const merge = key && lastKey.current && lastKey.current.key === key && now - lastKey.current.at < MERGE_WINDOW;
      if (!merge) {
        past.current.push(contentRef.current);
        if (past.current.length > HISTORY_LIMIT) past.current.shift();
      }
      lastKey.current = key ? { key, at: now } : null;
      future.current = [];
      contentRef.current = next;
      onChangeRef.current(next);
      syncHist();
    },
    [syncHist],
  );

  const restore = useCallback(
    (c: PageContent) => {
      lastKey.current = null;
      contentRef.current = c;
      onChangeRef.current(c);
      syncHist();
      const sel = ui.get().selectedId;
      if (sel && !findBlock(c.blocks ?? [], sel)) ui.set({ selectedId: null });
    },
    [syncHist, ui],
  );
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(contentRef.current);
    restore(prev);
  }, [restore]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(contentRef.current);
    restore(next);
  }, [restore]);

  const getContent = useCallback(() => contentRef.current, []);

  // ---------- operations ----------
  const setBlocks = useCallback(
    (fn: (blocks: Block[]) => Block[], key?: string) => {
      const c = contentRef.current;
      const cur = Array.isArray(c.blocks) ? c.blocks : [];
      const next = fn(cur);
      if (next !== cur) commit({ ...c, blocks: next }, key);
    },
    [commit],
  );

  const prepare = useCallback(
    (items: Block[]) => {
      if (mode !== 'email') return items;
      const ok = items.filter((b) => !['form', 'countdown', 'html'].includes(b.type));
      return adaptForEmail(ok);
    },
    [mode],
  );

  /** Where to insert when no explicit target: inside the selected section, else after the selection, else at the end. */
  const defaultTarget = useCallback(
    (items: Block[]): InsertTarget => {
      const bs = contentRef.current.blocks ?? [];
      const sel = ui.get().selectedId;
      const loc = sel ? findBlock(bs, sel) : null;
      const height = Math.max(0, ...items.map((b) => subtreeHeight(b) + 1));
      const fits = (list: string) => listDepth(bs, list) + height <= MAX_NESTING;
      if (loc) {
        if (loc.block.type === 'section' && fits(`s:${loc.block.id}`) && !items.some((b) => b.type === 'section')) {
          return { list: `s:${loc.block.id}`, index: loc.block.children?.length ?? 0 };
        }
        if (fits(loc.list)) return { list: loc.list, index: loc.index + 1 };
        const top = loc.path[0];
        const topIndex = top ? bs.findIndex((b) => b.id === top.id) : -1;
        if (topIndex >= 0) return { list: 'root', index: topIndex + 1 };
      }
      return { list: 'root', index: bs.length };
    },
    [ui],
  );

  const insertBlocksOp = useCallback(
    (items: Block[], target?: InsertTarget) => {
      const ready = prepare(items);
      if (!ready.length) return;
      const t = target ?? defaultTarget(ready);
      setBlocks((bs) => (getList(bs, t.list) ? insertBlocks(bs, t.list, t.index, ready) : insertBlocks(bs, 'root', bs.length, ready)));
      ui.set({ selectedId: ready[0]!.id });
    },
    [prepare, defaultTarget, setBlocks, ui],
  );

  const ops = useMemo<BuilderOps>(() => {
    const o: BuilderOps = {
      select: (id) => ui.set({ selectedId: id }),
      update: (id, patch, key) => setBlocks((bs) => mapBlock(bs, id, (b) => ({ ...b, ...patch }) as Block), key),
      updateStyle: (id, patch, key) =>
        setBlocks(
          (bs) =>
            mapBlock(bs, id, (b) => {
              const style: BlockStyle = { ...b.style, ...patch };
              for (const k of Object.keys(style) as (keyof BlockStyle)[]) if (style[k] === undefined) delete style[k];
              return { ...b, style } as Block;
            }),
          key,
        ),
      setField: (id, path, value, key) => setBlocks((bs) => mapBlock(bs, id, (b) => setPath(b, path, value)), key),
      updateSettings: (patch, key) => {
        const c = contentRef.current;
        const s = { ...defaults, ...c.settings, ...patch };
        for (const k of Object.keys(s) as (keyof typeof s)[]) if (s[k] === undefined) delete s[k];
        commit({ ...c, settings: s }, key);
      },
      replaceContent: (c) => {
        ui.set({ selectedId: null });
        commit({ settings: { ...defaults, ...c.settings }, blocks: prepare(c.blocks) });
      },
      insertBlocks: insertBlocksOp,
      insertType: (type, target) => {
        const block = type === 'columns' ? createColumns([50, 50]) : createBlock(type);
        insertBlocksOp([block], target);
      },
      move: (id, dir) =>
        setBlocks((bs) => {
          const loc = findBlock(bs, id);
          if (!loc) return bs;
          const j = loc.index + dir;
          const list = getList(bs, loc.list) ?? [];
          if (j < 0 || j >= list.length) return bs;
          return moveBlock(bs, id, loc.list, j);
        }),
      moveTo: (id, t) => setBlocks((bs) => moveBlock(bs, id, t.list, t.index)),
      duplicate: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc) return;
        const clone = cloneBlock(loc.block);
        setBlocks((bs) => insertBlocks(bs, loc.list, loc.index + 1, [clone]));
        ui.set({ selectedId: clone.id });
      },
      remove: (id) => {
        const bs0 = contentRef.current.blocks ?? [];
        const loc = findBlock(bs0, id);
        if (!loc) return;
        const list = getList(bs0, loc.list) ?? [];
        const neighbour = list[loc.index + 1] ?? list[loc.index - 1] ?? loc.path[loc.path.length - 1];
        setBlocks((bs) => removeBlock(bs, id).blocks);
        ui.set({ selectedId: neighbour ? neighbour.id : null });
      },
      copy: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc) return;
        writeClipboard(loc.block);
        toast.info(`${BLOCK_LABELS[loc.block.type]} copié — Ctrl+V pour coller (même sur une autre page)`);
      },
      cut: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc) return;
        writeClipboard(loc.block);
        o.remove(id);
      },
      paste: (target) => {
        const b = readClipboard(mode);
        if (!b) {
          toast.info('Le presse-papiers est vide (ou contient un bloc non disponible dans les emails).');
          return false;
        }
        insertBlocksOp([b], target ?? (ui.get().selectedId ? afterSelection() : undefined));
        return true;
      },
      wrapInSection: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc) return;
        const sec: Block = { id: uid(), type: 'section', children: [loc.block], style: { paddingTop: 40, paddingBottom: 40 } };
        setBlocks((bs) => {
          const r = removeBlock(bs, id);
          return insertBlocks(r.blocks, loc.list, loc.index, [sec]);
        });
        ui.set({ selectedId: sec.id });
      },
      unwrapSection: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc || loc.block.type !== 'section') return;
        const children = loc.block.children ?? [];
        setBlocks((bs) => insertBlocks(removeBlock(bs, id).blocks, loc.list, loc.index, children));
        ui.set({ selectedId: children[0]?.id ?? null });
      },
      saveAsSection: (id) => {
        const loc = findBlock(contentRef.current.blocks ?? [], id);
        if (!loc) return;
        const name = window.prompt('Nom de la section enregistrée', `${BLOCK_LABELS[loc.block.type]} ${new Date().toLocaleDateString('fr-FR')}`);
        if (!name?.trim()) return;
        const list = loadSavedSections();
        list.unshift({ id: uid(), name: name.trim().slice(0, 80), mode, block: JSON.parse(JSON.stringify(loc.block)), created_at: new Date().toISOString() });
        if (storeSavedSections(list.slice(0, 60))) toast.success('Section enregistrée dans « Sections › Mes sections »');
        else toast.error('Impossible d’enregistrer (stockage du navigateur plein)');
      },
      setColumnWidths: (id, widths) =>
        setBlocks((bs) =>
          mapBlock(bs, id, (b) => {
            if (b.type !== 'columns') return b;
            const cols = b.columns ?? [];
            const next = widths.map((w, i) => (cols[i] ? { ...cols[i]!, width: w } : { id: uid(), width: w, children: [] }));
            // merge the content of removed columns into the last kept one
            const extra = cols.slice(widths.length).flatMap((c) => c.children ?? []);
            if (extra.length) next[next.length - 1] = { ...next[next.length - 1]!, children: [...next[next.length - 1]!.children, ...extra] };
            return { ...b, columns: next };
          }),
        ),
    };
    function afterSelection(): InsertTarget | undefined {
      const sel = ui.get().selectedId;
      const loc = sel ? findBlock(contentRef.current.blocks ?? [], sel) : null;
      return loc ? { list: loc.list, index: loc.index + 1 } : undefined;
    }
    return o;
  }, [setBlocks, commit, defaults, mode, ui, insertBlocksOp, prepare, toast]);

  // ---------- inline editing ----------
  const inline = useInlineEditor(ops, ui, getContent);

  // ---------- overlays (media library, quick insert, context menu) ----------
  const [media, setMedia] = useState<{ onPick: (url: string) => void } | null>(null);
  const [quick, setQuick] = useState<{ target: InsertTarget; anchor: DOMRect } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const apiValue = useMemo<BuilderApi>(
    () => ({
      mode,
      ops,
      ui,
      getContent,
      openMedia: (onPick) => setMedia({ onPick }),
      openQuickInsert: (target, anchor) => setQuick({ target, anchor }),
      openContextMenu: (id, x, y) => setMenu({ id, x, y }),
      startInlineEdit: inline.start,
    }),
    [mode, ops, ui, getContent, inline.start],
  );

  useImperativeHandle(
    ref,
    () => ({ undo, redo, openTemplates: () => setTemplatesOpen(true), togglePreview: () => setPreview((p) => !p), openPanel: (id: string) => setPanel(id) }),
    [undo, redo, setPanel],
  );

  // ---------- keyboard shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('[role="dialog"], [role="menu"]')) return;
      if (target?.closest?.('[contenteditable="true"]')) return; // inline editing handles its own keys
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && k === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (isEditable(e.target)) return;
      const sel = ui.get().selectedId;
      if (e.key === 'Escape' && preview) {
        setPreview(false);
        return;
      }
      if (e.key === '?' && !mod) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (preview) return;
      if (mod && k === 'c' && sel) {
        if (window.getSelection()?.toString()) return;
        e.preventDefault();
        ops.copy(sel);
      } else if (mod && k === 'x' && sel) {
        e.preventDefault();
        ops.cut(sel);
      } else if (mod && k === 'v') {
        e.preventDefault();
        ops.paste();
      } else if (mod && k === 'd' && sel) {
        e.preventDefault();
        ops.duplicate(sel);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        e.preventDefault();
        ops.remove(sel);
      } else if (e.key === 'Escape' && sel) {
        ui.set({ selectedId: null });
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && sel) {
        e.preventDefault();
        ops.move(sel, e.key === 'ArrowUp' ? -1 : 1);
      } else if (e.key === 'Enter' && sel) {
        // Enter on a selected text block starts inline editing
        const el = document.querySelector<HTMLElement>(`[data-builder-block="${window.CSS.escape(sel)}"] [data-edit]`);
        const b = findBlock(contentRef.current.blocks ?? [], sel)?.block;
        if (el && b && el.closest('[data-builder-block]')?.getAttribute('data-builder-block') === sel) {
          e.preventDefault();
          const r = el.getBoundingClientRect();
          inline.start(sel, b.type, el.dataset.edit!, el, r.right - 2, r.bottom - 4);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, ops, ui, preview, inline.start]);

  // ---------- data for form blocks ----------
  const [tags, setTags] = useState<Tag[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  useEffect(() => {
    if (mode !== 'page') return;
    api.tags().then(setTags).catch(() => {});
    api.campaigns().then(setCampaigns).catch(() => {});
  }, [mode]);

  // ---------- drag & drop ----------
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [dragItem, setDragItem] = useState<DragItem | null>(null);
  const pointer = useRef({ x: 0, y: 0 });

  const draggedBlocks = (item: DragItem): Block[] => {
    if (item.kind === 'move') {
      const b = findBlock(contentRef.current.blocks ?? [], item.id)?.block;
      return b ? [b] : [];
    }
    if (item.kind === 'type') return [item.type === 'columns' ? createColumns([50, 50]) : createBlock(item.type)];
    if (item.kind === 'section') {
      const t = SECTION_TEMPLATES.find((s) => s.id === item.id);
      return t ? [buildSection(t, mode, settings.accent)] : [];
    }
    const saved = loadSavedSections().find((s) => s.id === item.id);
    return saved ? [cloneBlock(saved.block)] : [];
  };

  /** Finds the list under the pointer and the insertion index (DOM based, works for any nesting). */
  const computeDrop = (x: number, y: number, drag: { item: DragItem; blocks: Block[] }): DropTarget | null => {
    const item = drag.item;
    const frame = document.querySelector('[data-canvas-frame]');
    if (!frame) return null;
    const fr = frame.getBoundingClientRect();
    if (x < fr.left - 40 || x > fr.right + 40) return null;
    const dragId = item.kind === 'move' ? item.id : null;
    const draggedEl = dragId ? frame.querySelector(`[data-builder-block="${window.CSS.escape(dragId)}"]`) : null;
    let listEl: HTMLElement | null = null;
    for (const el of document.elementsFromPoint(x, y)) {
      const l = (el as HTMLElement).closest<HTMLElement>('[data-list-key]');
      if (l && frame.contains(l)) {
        listEl = l;
        break;
      }
    }
    listEl ??= frame.querySelector<HTMLElement>('[data-list-key="root"]');
    if (!listEl) return null;
    let cur: HTMLElement = listEl;
    if (draggedEl && draggedEl.contains(cur)) cur = draggedEl.parentElement?.closest<HTMLElement>('[data-list-key]') ?? cur;
    // near the top/bottom edge of a container: drop next to it rather than inside
    for (let i = 0; i < 4; i++) {
      const owner: HTMLElement | null | undefined = cur.parentElement?.closest<HTMLElement>('[data-builder-block]');
      if (!owner || owner === draggedEl) break;
      const r = owner.getBoundingClientRect();
      if (y - r.top > 10 && r.bottom - y > 10) break;
      const up: HTMLElement | null | undefined = owner.parentElement?.closest<HTMLElement>('[data-list-key]');
      if (!up) break;
      cur = up;
    }
    listEl = cur;
    const key = listEl.dataset.listKey!;
    const children = Array.from(listEl.querySelectorAll<HTMLElement>(':scope > [data-builder-block]')).filter((c) => c.dataset.builderBlock !== dragId);
    let index = children.length;
    for (let i = 0; i < children.length; i++) {
      const r = children[i]!.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        index = i;
        break;
      }
    }
    const bs = contentRef.current.blocks ?? [];
    if (dragId && isInside(bs, key, dragId)) return null;
    const moving = drag.blocks;
    const height = Math.max(0, ...moving.map((b) => subtreeHeight(b) + 1));
    if (listDepth(bs, key) + height > MAX_NESTING) return null;
    return { list: key, index };
  };

  const computeRef = useRef(computeDrop);
  computeRef.current = computeDrop;
  const dragRef = useRef<{ item: DragItem; blocks: Block[] } | null>(null);
  const rafRef = useRef(0);
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        const d = dragRef.current;
        if (d) ui.set({ drop: computeRef.current(pointer.current.x, pointer.current.y, d) });
      });
    },
    [ui],
  );

  // The drop is applied on our own pointerup listener (dnd-kit's onDragEnd is kept as a fallback):
  // it only depends on the pointer position, whatever dnd-kit's collision state is.
  const finishDrag = () => {
    const d = dragRef.current;
    if (!d) return;
    const drop = computeRef.current(pointer.current.x, pointer.current.y, d);
    endDrag();
    if (!drop) return;
    if (d.item.kind === 'move') opsRef.current.moveTo(d.item.id, drop);
    else insertRef.current(d.blocks, drop);
  };
  const finishRef = useRef(finishDrag);
  finishRef.current = finishDrag;
  const onPointerUp = useCallback((e: PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    finishRef.current();
  }, []);
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const insertRef = useRef(insertBlocksOp);
  insertRef.current = insertBlocksOp;

  const onDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as { from?: string; item?: DragItem } | undefined;
    const item: DragItem | null = data?.from === 'palette' && data.item ? data.item : data?.from === 'canvas' ? { kind: 'move', id: String(e.active.id) } : null;
    if (!item) return;
    const ev = e.activatorEvent as PointerEvent;
    pointer.current = { x: ev.clientX ?? 0, y: ev.clientY ?? 0 };
    if (!wide) setDragHide(true);
    dragRef.current = { item, blocks: draggedBlocks(item) };
    setDragItem(item);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp, true);
    ui.set({ dragId: item.kind === 'move' ? item.id : null, selectedId: item.kind === 'move' ? item.id : ui.get().selectedId, hoverId: null });
  };
  function endDrag() {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp, true);
    cancelAnimationFrame(rafRef.current);
    dragRef.current = null;
    setDragItem(null);
    if (dragHide) {
      setDragHide(false);
      setPanelState(null);
    }
    ui.set({ dragId: null, drop: null });
  }
  const onDragEnd = (_e: DragEndEvent) => finishDrag();

  const selectedLoc = selectedId ? findBlock(blocks, selectedId) : null;
  const selected = selectedLoc?.block ?? null;

  const DragIcon = dragItem ? (dragItem.kind === 'type' ? BLOCK_ICONS[dragItem.type] : dragItem.kind === 'move' ? BLOCK_ICONS[findBlock(blocks, dragItem.id)?.block.type ?? 'text'] : BLOCK_ICONS.section) : null;
  const dragLabel = dragItem
    ? dragItem.kind === 'type'
      ? BLOCK_LABELS[dragItem.type]
      : dragItem.kind === 'move'
        ? BLOCK_LABELS[findBlock(blocks, dragItem.id)?.block.type ?? 'text']
        : dragItem.kind === 'section'
          ? SECTION_TEMPLATES.find((s) => s.id === dragItem.id)?.name ?? 'Section'
          : loadSavedSections().find((s) => s.id === dragItem.id)?.name ?? 'Section'
    : '';

  const togglePreview = () => setPreview((p) => !p);
  const isEmail = mode === 'email';

  const rail: { id: string; label: string; icon: LucideIcon; action?: () => void; dot?: boolean }[] = [
    { id: 'add', label: 'Ajouter', icon: Plus },
    { id: 'sections', label: 'Sections', icon: PanelsTopLeft },
    { id: 'layers', label: 'Calques', icon: Layers },
    { id: 'templates', label: 'Modèles', icon: LayoutTemplate, action: () => setTemplatesOpen(true) },
    {
      id: 'media',
      label: 'Médias',
      icon: ImageIcon,
      action: () =>
        setMedia({
          onPick: (url) => {
            const img = createBlock('image');
            insertBlocksOp([{ ...img, src: url } as Block]);
          },
        }),
    },
    ...panels.map((p) => ({ id: p.id, label: p.label, icon: p.icon, dot: p.dot })),
    { id: 'settings', label: isEmail ? 'Réglages de l’email' : 'Réglages de la page', icon: Settings2 },
  ];
  const panelTitle = rail.find((r) => r.id === activePanel)?.label ?? '';
  const flyoutOpen = !!activePanel && !preview;
  const showInspector = !!selected && !preview && !(inspectorHidden && !wide);

  let flyoutBody: ReactNode = null;
  if (activePanel === 'add') flyoutBody = <AddPanel mode={mode} />;
  else if (activePanel === 'sections') flyoutBody = <SectionsPanel mode={mode} accent={settings.accent} />;
  else if (activePanel === 'layers') flyoutBody = <LayersPanel blocks={blocks} />;
  else if (activePanel === 'settings') flyoutBody = <SettingsPanel mode={mode} settings={settings} />;
  else if (activePanel) flyoutBody = panels.find((p) => p.id === activePanel)?.render() ?? null;

  return (
    <BuilderContext.Provider value={apiValue}>
      <div className={cx('flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-slate-100', className)}>
        {/* ---------- single top bar ---------- */}
        <header className="relative z-50 flex h-14 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-2 sm:px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1">{barStart}</div>
          <div className="flex shrink-0 items-center gap-1.5">
            {preview ? (
              <>
                <span className="hidden items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600 lg:inline-flex">
                  <Eye size={13} /> Aperçu — liens désactivés
                </span>
                <DeviceToggle device={device} onChange={setDevice} />
              </>
            ) : (
              <>
                <div className="flex items-center">
                  <BarIcon icon={Undo2} label="Annuler" kbd="Ctrl+Z" onClick={undo} disabled={!hist.canUndo} />
                  <BarIcon icon={Redo2} label="Rétablir" kbd="Ctrl+Maj+Z" onClick={redo} disabled={!hist.canRedo} />
                </div>
                <span className="hidden h-5 w-px bg-slate-200 md:block" />
                <div className="hidden md:block">
                  <DeviceToggle device={device} onChange={setDevice} />
                </div>
              </>
            )}
          </div>
          <div className="flex flex-1 items-center justify-end gap-1.5">{barEnd?.({ preview, togglePreview })}</div>
        </header>

        {preview ? (
          <PreviewFrame content={{ settings, blocks }} mode={mode} device={device} title={title ?? 'Aperçu'} />
        ) : (
          <DndContext sensors={sensors} autoScroll={{ threshold: { x: 0, y: 0.12 } }} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={endDrag}>
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              {/* ---------- icon rail ---------- */}
              <nav className="z-40 flex w-12 shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-white py-2" aria-label="Outils de l’éditeur">
                {rail.map((r, i) => {
                  const active = !r.action && activePanel === r.id;
                  const sepBefore = r.id === 'templates' || (i > 0 && r.id === 'settings');
                  return (
                    <div key={r.id} className={cx('flex flex-col items-center', r.id === 'settings' && 'mt-auto')}>
                      {sepBefore && r.id !== 'settings' && <span className="my-1 h-px w-6 bg-slate-200" />}
                      <RailButton
                        icon={r.icon}
                        label={r.label}
                        active={active}
                        dot={r.dot}
                        onClick={() => (r.action ? r.action() : setPanel(active ? null : r.id))}
                      />
                    </div>
                  );
                })}
              </nav>

              {/* ---------- flyout (one panel at a time) ---------- */}
              {flyoutOpen && (
                <aside
                  className={cx(
                    'flex w-[280px] max-w-[calc(100vw-48px)] shrink-0 flex-col border-r border-slate-200 bg-white select-none',
                    !wide && 'absolute inset-y-0 left-12 z-30 animate-slide-in-left shadow-float',
                    dragHide && 'pointer-events-none opacity-0',
                  )}
                >
                  <div className="flex h-11 shrink-0 items-center justify-between pr-2 pl-4">
                    <h2 className="text-[13px] font-semibold text-slate-900">{panelTitle}</h2>
                    <button type="button" onClick={() => setPanel(null)} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Fermer le panneau" aria-label="Fermer le panneau">
                      <X size={15} />
                    </button>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col">{flyoutBody}</div>
                </aside>
              )}

              {/* ---------- canvas ---------- */}
              <div className="relative flex min-w-0 flex-1 flex-col">
                <Canvas blocks={blocks} settings={settings} mode={mode} device={device} zoom={zoom} onOpenTemplates={() => setTemplatesOpen(true)} />

                {/* floating: shortcuts + zoom */}
                <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-2">
                  <div className="pointer-events-auto flex items-center rounded-lg bg-white/95 p-0.5 text-slate-600 shadow-float backdrop-blur">
                    <button type="button" onClick={() => setShortcutsOpen(true)} className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-900" title="Raccourcis clavier (?)" aria-label="Raccourcis clavier">
                      <CircleHelp size={15} />
                    </button>
                    <span className="mx-0.5 hidden h-4 w-px bg-slate-200 sm:block" />
                    <div className="hidden items-center sm:flex">
                      <button
                        type="button"
                        onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)] ?? z)}
                        disabled={zoom <= ZOOMS[0]!}
                        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
                        title="Zoom arrière"
                        aria-label="Zoom arrière"
                      >
                        <Minus size={14} />
                      </button>
                      <button type="button" onClick={() => setZoom(100)} className="h-7 w-11 rounded-md text-center text-xs font-medium tabular-nums hover:bg-slate-100 hover:text-slate-900" title="Réinitialiser le zoom">
                        {zoom}%
                      </button>
                      <button
                        type="button"
                        onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)] ?? z)}
                        disabled={zoom >= ZOOMS[ZOOMS.length - 1]!}
                        className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30"
                        title="Zoom avant"
                        aria-label="Zoom avant"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* narrow screens: bring back a tucked-away inspector */}
                {!wide && selected && inspectorHidden && (
                  <button
                    type="button"
                    onClick={() => setInspectorHidden(false)}
                    className="absolute top-3 right-3 z-20 inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-2.5 text-sm font-medium text-slate-700 shadow-float hover:text-slate-900"
                  >
                    <SlidersHorizontal size={14} /> Propriétés
                  </button>
                )}
              </div>

              {/* ---------- inspector (only with a selection) ---------- */}
              {showInspector && selected && (
                <div
                  className={cx(
                    'flex',
                    !wide && !phone && 'absolute inset-y-0 right-0 z-30 max-w-[calc(100vw-48px)] animate-slide-in shadow-float',
                    phone && 'absolute right-0 bottom-0 left-12 z-30 h-[58%] animate-pop-in overflow-hidden rounded-tl-2xl shadow-pop',
                  )}
                >
                  <Inspector
                    mode={mode}
                    block={selected}
                    path={selectedLoc?.path ?? []}
                    settings={settings}
                    tags={tags}
                    campaigns={campaigns}
                    className={phone ? 'w-full border-l-0' : undefined}
                    onClose={() => (wide ? ops.select(null) : setInspectorHidden(true))}
                  />
                </div>
              )}
            </div>

            <DragOverlay dropAnimation={null}>
              {dragItem && DragIcon ? (
                <div className="pointer-events-none flex w-44 cursor-grabbing items-center gap-2 rounded-lg bg-white px-2.5 py-2 text-sm font-medium text-slate-800 shadow-pop ring-2 ring-brand-500/30">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-50 text-brand-600">
                    <DragIcon size={14} />
                  </span>
                  <span className="truncate">{dragLabel}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>

      {inline.overlay}
      {quick && <QuickInsert mode={mode} anchor={quick.anchor} accent={settings.accent} onClose={() => setQuick(null)} onInsert={(bs) => insertBlocksOp(bs, quick.target)} />}
      {menu && <ContextMenu id={menu.id} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      <MediaLibrary
        open={!!media}
        onClose={() => setMedia(null)}
        onPick={(url) => {
          media?.onPick(url);
          setMedia(null);
        }}
      />
      <TemplateGallery
        open={templatesOpen}
        mode={mode}
        hasContent={blocks.length > 0}
        onClose={() => setTemplatesOpen(false)}
        onPick={(c) => {
          ops.replaceContent(c);
          setTemplatesOpen(false);
          toast.success('Modèle appliqué — Ctrl+Z pour revenir en arrière');
        }}
      />
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </BuilderContext.Provider>
  );
}

function RailButton({ icon: Icon, label, active, dot, onClick }: { icon: LucideIcon; label: string; active: boolean; dot?: boolean; onClick: () => void }) {
  return (
    <span className="group/rail relative">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cx(
          'relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
          active ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-100 ring-inset' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
        )}
      >
        <Icon size={18} strokeWidth={1.85} />
        {dot && <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-brand-500 ring-2 ring-white" />}
      </button>
      <span className="pointer-events-none absolute top-1/2 left-full z-50 ml-2 -translate-y-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg transition-opacity group-hover/rail:opacity-100 group-hover/rail:delay-300">
        {label}
      </span>
    </span>
  );
}

/** Icon button of the editor top bar, with a tooltip showing the shortcut. */
export function BarIcon({ icon: Icon, label, kbd, onClick, disabled, active, className }: { icon: LucideIcon; label: string; kbd?: string; onClick?: () => void; disabled?: boolean; active?: boolean; className?: string }) {
  return (
    <span className="group/bar relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cx(
          'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-35 disabled:hover:bg-transparent',
          active ? 'bg-slate-100 text-slate-900' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900',
          className,
        )}
      >
        <Icon size={17} />
      </button>
      <span className="pointer-events-none absolute top-full left-1/2 z-[70] mt-1.5 -translate-x-1/2 rounded-md bg-slate-900 px-2 py-1 text-xs font-medium whitespace-nowrap text-white opacity-0 shadow-lg transition-opacity group-hover/bar:opacity-100 group-hover/bar:delay-300">
        {label}
        {kbd && <span className="ml-1.5 text-slate-400">{kbd}</span>}
      </span>
    </span>
  );
}

export function DeviceToggle({ device, onChange }: { device: Device; onChange: (d: Device) => void }) {
  return (
    <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
      {(
        [
          ['desktop', Monitor, 'Ordinateur'],
          ['tablet', Tablet, 'Tablette (768 px)'],
          ['mobile', Smartphone, 'Mobile (390 px)'],
        ] as const
      ).map(([d, Icon, label]) => (
        <button
          key={d}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={device === d}
          onClick={() => onChange(d)}
          className={cx('inline-flex h-7 w-8 items-center justify-center rounded-md transition-all', device === d ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}

function useMediaQuery(query: string) {
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return match;
}

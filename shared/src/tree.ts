// Immutable helpers for the block tree (sections → children, columns → columns[].children).
// A "list key" identifies a list of blocks: 'root', `s:<sectionId>` or `c:<columnId>`.
import type { Block, Column } from './types';
import { uid } from './templates';

export type ListKey = string;
export const ROOT: ListKey = 'root';

export interface BlockLocation {
  list: ListKey;
  index: number;
  /** ancestors from the root (outermost first), not including the block itself */
  path: Block[];
}

const isObj = (b: unknown): b is Block => !!b && typeof b === 'object';

/** Lists directly contained by a block (with their keys). */
export function childLists(b: Block): { key: ListKey; blocks: Block[]; column?: Column }[] {
  if (b.type === 'section') return [{ key: `s:${b.id}`, blocks: Array.isArray(b.children) ? b.children : [] }];
  if (b.type === 'columns') return (Array.isArray(b.columns) ? b.columns : []).map((c) => ({ key: `c:${c.id}`, blocks: Array.isArray(c.children) ? c.children : [], column: c }));
  return [];
}

/** Depth-first visit. Return false from the visitor to skip the children of a block. */
export function walk(blocks: Block[], fn: (b: Block, loc: BlockLocation) => void | false, list: ListKey = ROOT, path: Block[] = []) {
  (Array.isArray(blocks) ? blocks : []).forEach((b, index) => {
    if (!isObj(b)) return;
    if (fn(b, { list, index, path }) === false) return;
    for (const l of childLists(b)) walk(l.blocks, fn, l.key, [...path, b]);
  });
}

export function findBlock(blocks: Block[], id: string): (BlockLocation & { block: Block }) | null {
  let found: (BlockLocation & { block: Block }) | null = null;
  walk(blocks, (b, loc) => {
    if (found) return false;
    if (b.id === id) found = { ...loc, block: b };
  });
  return found;
}

export function getList(blocks: Block[], key: ListKey): Block[] | null {
  if (key === ROOT) return blocks;
  let out: Block[] | null = null;
  walk(blocks, (b) => {
    if (out) return false;
    for (const l of childLists(b)) if (l.key === key) out = l.blocks;
  });
  return out;
}

/** Block owning a list (null for root). */
export function listOwner(blocks: Block[], key: ListKey): Block | null {
  if (key === ROOT) return null;
  let out: Block | null = null;
  walk(blocks, (b) => {
    if (out) return false;
    if (childLists(b).some((l) => l.key === key)) out = b;
  });
  return out;
}

/** Returns a new tree where the list `key` is replaced by fn(list). */
export function mapList(blocks: Block[], key: ListKey, fn: (list: Block[]) => Block[]): Block[] {
  if (key === ROOT) return fn(blocks);
  let changed = false;
  const rec = (list: Block[]): Block[] => {
    let listChanged = false;
    const next = list.map((b) => {
      if (!isObj(b) || changed) return b;
      if (b.type === 'section') {
        if (`s:${b.id}` === key) {
          changed = listChanged = true;
          return { ...b, children: fn(b.children ?? []) };
        }
        const children = rec(b.children ?? []);
        if (children !== b.children) {
          listChanged = true;
          return { ...b, children };
        }
      } else if (b.type === 'columns') {
        let colsChanged = false;
        const columns = (b.columns ?? []).map((c) => {
          if (changed) return c;
          if (`c:${c.id}` === key) {
            changed = colsChanged = true;
            return { ...c, children: fn(c.children ?? []) };
          }
          const children = rec(c.children ?? []);
          if (children !== c.children) {
            colsChanged = true;
            return { ...c, children };
          }
          return c;
        });
        if (colsChanged) {
          listChanged = true;
          return { ...b, columns };
        }
      }
      return b;
    });
    return listChanged ? next : list;
  };
  return rec(blocks);
}

/** Returns a new tree with block `id` replaced by fn(block). */
export function mapBlock(blocks: Block[], id: string, fn: (b: Block) => Block): Block[] {
  const loc = findBlock(blocks, id);
  if (!loc) return blocks;
  return mapList(blocks, loc.list, (list) => list.map((b) => (b.id === id ? fn(b) : b)));
}

export function removeBlock(blocks: Block[], id: string): { blocks: Block[]; removed: Block | null; loc: BlockLocation | null } {
  const loc = findBlock(blocks, id);
  if (!loc) return { blocks, removed: null, loc: null };
  return { blocks: mapList(blocks, loc.list, (list) => list.filter((b) => b.id !== id)), removed: loc.block, loc };
}

export function insertBlocks(blocks: Block[], key: ListKey, index: number, items: Block[]): Block[] {
  return mapList(blocks, key, (list) => {
    const copy = list.slice();
    copy.splice(Math.max(0, Math.min(index, copy.length)), 0, ...items);
    return copy;
  });
}

/** Moves a block to (key, index); index is computed on the list *without* the moved block. */
export function moveBlock(blocks: Block[], id: string, key: ListKey, index: number): Block[] {
  if (isInside(blocks, key, id)) return blocks;
  const r = removeBlock(blocks, id);
  if (!r.removed) return blocks;
  return insertBlocks(r.blocks, key, index, [r.removed]);
}

/** True when list `key` belongs to block `id` or one of its descendants (dropping there would create a cycle). */
export function isInside(blocks: Block[], key: ListKey, id: string): boolean {
  if (key === ROOT) return false;
  const loc = findBlock(blocks, id);
  if (!loc) return false;
  let inside = false;
  walk([loc.block], (b) => {
    if (childLists(b).some((l) => l.key === key)) inside = true;
  });
  return inside;
}

/** Nesting depth of a list (root = 0). */
export function listDepth(blocks: Block[], key: ListKey): number {
  if (key === ROOT) return 0;
  const owner = listOwner(blocks, key);
  if (!owner) return 0;
  const loc = findBlock(blocks, owner.id);
  return (loc?.path.length ?? 0) + 1;
}

/** Height of a subtree (leaf = 0, section with leaves = 1...). */
export function subtreeHeight(b: Block): number {
  let max = 0;
  for (const l of childLists(b)) for (const c of l.blocks) max = Math.max(max, 1 + subtreeHeight(c));
  return max;
}

/** Deep copy with fresh ids (blocks and columns). */
export function cloneBlock<T extends Block>(b: T): T {
  const copy = JSON.parse(JSON.stringify(b)) as Block;
  const renew = (x: Block) => {
    x.id = uid();
    if (x.type === 'section') (x.children ?? []).forEach(renew);
    if (x.type === 'columns') (x.columns ?? []).forEach((c) => {
      c.id = uid();
      (c.children ?? []).forEach(renew);
    });
  };
  renew(copy);
  return copy as T;
}

/** Sets a nested field by dotted path ("items.2.q") immutably. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split('.');
  const src = obj as unknown as Record<string, unknown> | unknown[];
  const cur = Array.isArray(src) ? src[Number(head)] : (src as Record<string, unknown>)[head!];
  const next = rest.length ? setPath(cur ?? {}, rest.join('.'), value) : value;
  if (Array.isArray(src)) {
    const copy = src.slice();
    copy[Number(head)] = next;
    return copy as unknown as T;
  }
  return { ...(src as object), [head!]: next } as T;
}

export function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

/** Every block of a given type in the tree. */
export function blocksOfType<T extends Block['type']>(blocks: Block[], type: T): Extract<Block, { type: T }>[] {
  const out: Extract<Block, { type: T }>[] = [];
  walk(blocks, (b) => {
    if (b.type === type) out.push(b as Extract<Block, { type: T }>);
  });
  return out;
}

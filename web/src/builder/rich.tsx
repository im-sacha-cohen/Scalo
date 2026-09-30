// Rich text editing primitives shared by the inline canvas editor and the inspector fields.
// Formatting uses document.execCommand on a contentEditable element; the result is always passed
// through the shared allowlist sanitizer (`normalizeRich`) before being stored.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Bold, Braces, Check, Italic, Link2, Palette, RemoveFormatting, Strikethrough, Underline, Unlink, X } from 'lucide-react';
import { esc, normalizeRich, richToEditable } from '@scalo/shared';
import { cx } from '../components/ui';
import { MERGE_TAGS } from './meta';
import { useMergeTags } from '../lib/crm-refs';

const SWATCHES = ['#0f172a', '#475569', '#ffffff', '#5b4bff', '#2563eb', '#0ea5e9', '#059669', '#16a34a', '#f59e0b', '#ea580c', '#dc2626', '#db2777', '#7c3aed'];

function saveRange(): Range | null {
  const s = window.getSelection();
  return s && s.rangeCount ? s.getRangeAt(0).cloneRange() : null;
}
function restoreRange(r: Range | null) {
  if (!r) return;
  const host = (r.commonAncestorContainer instanceof HTMLElement ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement)?.closest<HTMLElement>('[contenteditable="true"]');
  host?.focus({ preventScroll: true });
  const s = window.getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

export function exec(cmd: string, value?: string) {
  document.execCommand(cmd, false, value);
}

/**
 * Formatting toolbar. Buttons keep the focus in the edited element (mousedown is prevented).
 * `onChange` is called after each command so controlled editors can read the new HTML.
 */
export function RichToolbar({ onChange, dark, compact, extra }: { onChange?: () => void; dark?: boolean; compact?: boolean; extra?: ReactNode }) {
  const [panel, setPanel] = useState<null | 'link' | 'color' | 'tags'>(null);
  const [url, setUrl] = useState('');
  const range = useRef<Range | null>(null);
  const mergeTags = useMergeTags(MERGE_TAGS); // + {{field.key}} of the account's custom fields

  const run = (cmd: string, value?: string) => {
    exec(cmd, value);
    onChange?.();
  };
  const openPanel = (p: 'link' | 'color' | 'tags') => {
    range.current = saveRange();
    if (p === 'link') {
      const a = range.current?.commonAncestorContainer.parentElement?.closest('a');
      setUrl(a?.getAttribute('href') ?? 'https://');
    }
    setPanel((cur) => (cur === p ? null : p));
  };
  const applyLink = () => {
    restoreRange(range.current);
    const u = url.trim();
    if (u && u !== 'https://') {
      if (range.current && !range.current.collapsed) exec('createLink', u);
      else exec('insertHTML', `<a href="${esc(u)}">${esc(u.replace(/^https?:\/\//, ''))}</a>`);
      onChange?.();
    }
    setPanel(null);
  };

  const btn = cx(
    'flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1 text-xs transition-colors',
    dark ? 'text-slate-200 hover:bg-white/10 hover:text-white' : 'text-slate-500 hover:bg-white hover:text-slate-900 hover:shadow-sm',
  );
  const keep = (e: React.MouseEvent) => e.preventDefault();
  const sep = <span className={cx('mx-0.5 h-4 w-px', dark ? 'bg-white/15' : 'bg-slate-200')} />;

  return (
    <div className="relative" data-rich-toolbar="">
      <div className="flex flex-wrap items-center gap-0.5" onMouseDown={keep}>
        <button type="button" className={btn} title="Gras (Ctrl+B)" onClick={() => run('bold')}>
          <Bold size={14} />
        </button>
        <button type="button" className={btn} title="Italique (Ctrl+I)" onClick={() => run('italic')}>
          <Italic size={14} />
        </button>
        <button type="button" className={btn} title="Souligné (Ctrl+U)" onClick={() => run('underline')}>
          <Underline size={14} />
        </button>
        {!compact && (
          <button type="button" className={btn} title="Barré" onClick={() => run('strikeThrough')}>
            <Strikethrough size={14} />
          </button>
        )}
        {sep}
        <button type="button" className={cx(btn, panel === 'link' && (dark ? 'bg-white/15' : 'bg-white shadow-sm'))} title="Lien" onClick={() => openPanel('link')}>
          <Link2 size={14} />
        </button>
        <button type="button" className={btn} title="Retirer le lien" onClick={() => run('unlink')}>
          <Unlink size={14} />
        </button>
        <button type="button" className={cx(btn, panel === 'color' && (dark ? 'bg-white/15' : 'bg-white shadow-sm'))} title="Couleur du texte" onClick={() => openPanel('color')}>
          <Palette size={14} />
        </button>
        {!compact && (
          <button type="button" className={btn} title="Effacer la mise en forme" onClick={() => run('removeFormat')}>
            <RemoveFormatting size={14} />
          </button>
        )}
        {sep}
        <button type="button" className={cx(btn, panel === 'tags' && (dark ? 'bg-white/15' : 'bg-white shadow-sm'))} title="Insérer une variable du contact" onClick={() => openPanel('tags')}>
          <Braces size={13} />
        </button>
        {extra}
      </div>

      {panel && (
        <div
          className="absolute top-full left-0 z-[80] mt-1.5 min-w-[220px] animate-pop-in rounded-xl border border-slate-200 bg-white p-2 text-slate-700 shadow-pop"
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
          }}
        >
          {panel === 'link' && (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                applyLink();
              }}
            >
              <input
                autoFocus
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setPanel(null);
                    restoreRange(range.current);
                  }
                }}
                placeholder="https://…"
                className="h-8 w-56 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-brand-500"
              />
              <button type="submit" className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-600 text-white hover:bg-brand-700" title="Appliquer">
                <Check size={15} />
              </button>
              <button type="button" onClick={() => setPanel(null)} className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100" title="Fermer">
                <X size={15} />
              </button>
            </form>
          )}
          {panel === 'color' && (
            <div className="grid grid-cols-7 gap-1.5">
              {SWATCHES.map((c) => (
                <button
                  key={c}
                  type="button"
                  title={c}
                  onClick={() => {
                    restoreRange(range.current);
                    run('foreColor', c);
                    setPanel(null);
                  }}
                  className="h-6 w-6 rounded-md ring-1 ring-slate-200 transition-transform hover:scale-110"
                  style={{ background: c }}
                />
              ))}
              <label className="relative flex h-6 w-6 cursor-pointer items-center justify-center overflow-hidden rounded-md bg-[conic-gradient(red,yellow,lime,aqua,blue,magenta,red)] ring-1 ring-slate-200" title="Couleur personnalisée">
                <input
                  type="color"
                  className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
                  onChange={(e) => {
                    restoreRange(range.current);
                    run('foreColor', e.target.value);
                    range.current = saveRange();
                  }}
                />
              </label>
            </div>
          )}
          {panel === 'tags' && (
            <div className="flex flex-col">
              <p className="px-2 pb-1 text-[11px] text-slate-400">Remplacé par l’info du contact</p>
              {mergeTags.map((t) => (
                <button
                  key={t.tag}
                  type="button"
                  onClick={() => {
                    restoreRange(range.current);
                    run('insertText', t.tag);
                    setPanel(null);
                  }}
                  className="flex items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100"
                >
                  {t.label}
                  <code className="text-[11px] text-slate-400">{t.tag}</code>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Pastes clipboard content as plain text (never foreign HTML). */
export function pastePlain(e: ClipboardEvent | React.ClipboardEvent) {
  e.preventDefault();
  const text = e.clipboardData?.getData('text/plain') ?? '';
  exec('insertText', text);
}

/**
 * Inspector rich-text field (contentEditable + toolbar). Value in/out is a stored rich-text value
 * (legacy markdown-lite accepted as input; output is sanitized HTML or plain text).
 */
export function RichField({
  value,
  onChange,
  minHeight = 72,
  placeholder,
  singleLine,
  onEnter,
  compact,
  primary,
}: {
  value: string;
  onChange: (v: string) => void;
  minHeight?: number;
  placeholder?: string;
  singleLine?: boolean;
  onEnter?: () => void;
  compact?: boolean;
  primary?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [empty, setEmpty] = useState(!value);

  // sync external changes (inline canvas edits, undo...) when the field is not being edited
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === last.current && document.activeElement === el) return;
    if (document.activeElement === el) return;
    el.innerHTML = richToEditable(value);
    last.current = value;
    setEmpty(!value);
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const v = normalizeRich(el.innerHTML);
    setEmpty(!el.textContent);
    if (v !== last.current) {
      last.current = v;
      onChange(v);
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => pastePlain(e);
    const onDrop = (e: DragEvent) => e.preventDefault(); // never let foreign HTML be dropped in
    el.addEventListener('paste', onPaste);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('paste', onPaste);
      el.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className={cx('overflow-visible rounded-lg border bg-white transition', focused ? 'border-brand-500 ring-4 ring-brand-500/15' : 'border-slate-200')}>
      <div className="rounded-t-lg border-b border-slate-100 bg-slate-50 px-1 py-1">
        <RichToolbar onChange={emit} compact={compact} />
      </div>
      <div className="relative">
        {empty && placeholder && <div className="pointer-events-none absolute top-2 left-2.5 text-sm text-slate-400">{placeholder}</div>}
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          data-primary-field={primary ? '' : undefined}
          role="textbox"
          aria-multiline={!singleLine}
          onInput={emit}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            emit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (singleLine) onEnter?.();
              else exec('insertLineBreak');
            }
          }}
          className="scalo-rich max-h-72 overflow-y-auto px-2.5 py-2 text-sm leading-relaxed text-slate-900 outline-none [&_a]:text-brand-600 [&_a]:underline [&_b]:font-bold [&_em]:italic [&_i]:italic [&_strong]:font-bold"
          style={{ minHeight: singleLine ? undefined : minHeight }}
        />
      </div>
    </div>
  );
}

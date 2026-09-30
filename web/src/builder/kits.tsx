// Kits in the app: real previews (rendered by the shared renderer), the kit picker and the email template picker.
import { useEffect, useMemo, useState } from 'react';
import { CircleCheck, FileText, Search } from 'lucide-react';
import {
  KITS,
  KIT_EMAILS,
  KIT_EMAIL_KINDS,
  KIT_FLOWS,
  KIT_PAGES,
  KIT_PREVIEW_OFFERS,
  kitEmail,
  kitPage,
  renderEmailDocument,
  renderPageDocument,
  withPreviewOffers,
  type KitDefinition,
  type KitEmailKind,
  type KitGoal,
  type KitPageKind,
  type PageContent,
} from '@scalo/shared';
import { api } from '../lib/api';
import { cx } from '../components/ui';
import { DocThumb } from './TemplateGallery';

const EXAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie@exemple.fr', phone: '' };

/** HTML of a page as the gallery shows it (payment blocks display a sample offer). */
export const previewPageHtml = (content: PageContent, title = 'Aperçu') =>
  // thumbnails are script-less sandboxed frames: drop the countdown script instead of letting the browser block it
  renderPageDocument(withPreviewOffers(content), { title, nextUrl: '#', formAction: '#', vars: EXAMPLE_VARS, offers: KIT_PREVIEW_OFFERS }).replace(/<script[\s\S]*?<\/script>/g, '');
export const previewEmailHtml = (content: PageContent, subject = 'Aperçu') => renderEmailDocument(content, { subject, vars: EXAMPLE_VARS });

const cache = new Map<string, string>();
/** Preview of a kit page, rendered once per session. */
export function kitPagePreview(kitId: string, kind: KitPageKind): string {
  const key = `p:${kitId}:${kind}`;
  let html = cache.get(key);
  if (html === undefined) {
    const c = kitPage(kitId, kind);
    html = c ? previewPageHtml(c, KIT_PAGES[kind].name) : '';
    cache.set(key, html);
  }
  return html;
}
export function kitEmailPreview(kitId: string, kind: KitEmailKind): string {
  const key = `e:${kitId}:${kind}`;
  let html = cache.get(key);
  if (html === undefined) {
    const e = kitEmail(kitId, kind);
    html = e ? previewEmailHtml(e.content, e.subject) : '';
    cache.set(key, html);
  }
  return html;
}

export const KIT_GOAL_LABELS: Record<KitGoal, string> = { capture: 'Capture', vente: 'Vente', webinaire: 'Webinaire', lancement: 'Lancement' };

/** Kit of the account's most recent funnel that has one: proposed first so emails look like the pages. */
export function usePreferredKit(): string | null {
  const [kit, setKit] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .funnels()
      .then((fs) => {
        const k = fs.find((f) => f.kit && KITS.some((x) => x.id === f.kit))?.kit;
        if (alive && k) setKit(k);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return kit;
}

/** Palette and type sample of a kit. */
export function KitSwatch({ kit, className }: { kit: KitDefinition; className?: string }) {
  const t = kit.tokens;
  return (
    <span className={cx('flex items-center gap-1', className)} aria-hidden="true">
      {[t.bg, t.alt, t.text, t.accent, t.accent2].map((c, i) => (
        <span key={i} className="h-3.5 w-3.5 rounded-full ring-1 ring-slate-900/10" style={{ background: c }} />
      ))}
    </span>
  );
}

export function Chips<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map(([id, text]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={value === id}
          onClick={() => onChange(id)}
          className={cx('h-8 rounded-full px-3.5 text-sm font-medium transition-colors', value === id ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className="relative block">
      <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-9 w-full rounded-lg border border-slate-200 bg-white pr-3 pl-9 text-sm outline-none placeholder:text-slate-400 focus:border-brand-400 focus:ring-4 focus:ring-brand-500/10"
      />
    </label>
  );
}

const norm = (s: string) => s.toLocaleLowerCase('fr-FR').normalize('NFD').replace(/[̀-ͯ]/g, '');
export const kitMatches = (kit: KitDefinition, q: string) => !q.trim() || norm(`${kit.name} ${kit.universe} ${kit.pitch}`).includes(norm(q.trim()));
export const textMatches = (text: string, q: string) => !q.trim() || norm(text).includes(norm(q.trim()));

/** Kits as cards with a real preview of one of their pages. */
export function KitCards({
  value,
  onChange,
  kits = KITS,
  thumb = 'sales',
  width = 236,
  preferred,
}: {
  value: string | null;
  onChange: (kitId: string) => void;
  kits?: KitDefinition[];
  thumb?: KitPageKind;
  width?: number;
  preferred?: string | null;
}) {
  if (!kits.length) return <p className="rounded-xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">Aucun kit ne correspond à cette recherche.</p>;
  return (
    <div role="radiogroup" aria-label="Kit" className="grid justify-items-start gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${width}px, 1fr))` }}>
      {kits.map((kit) => {
        const active = value === kit.id;
        return (
          <button
            key={kit.id}
            type="button"
            role="radio"
            aria-checked={active}
            data-kit={kit.id}
            onClick={() => onChange(kit.id)}
            className={cx(
              'relative overflow-hidden rounded-xl border-2 bg-white text-left transition-all',
              active ? 'border-brand-500 ring-4 ring-brand-500/10' : 'border-slate-200 hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-card',
            )}
            style={{ width }}
          >
            <span className="block border-b border-slate-100">
              <DocThumb html={kitPagePreview(kit.id, thumb)} width={width - 4} ratio={0.72} />
            </span>
            {active && <CircleCheck size={20} className="absolute top-2 right-2 rounded-full bg-white text-brand-600" />}
            <span className="block px-3 py-2.5">
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-900">
                  {kit.name}
                  {preferred === kit.id && <span className="ml-1.5 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">votre kit</span>}
                </span>
                <KitSwatch kit={kit} />
              </span>
              <span className="mt-0.5 block text-[11px] font-medium text-slate-500">{kit.universe}</span>
              <span className="mt-1 block text-xs leading-snug text-slate-500">{kit.pitch}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The pages a funnel type creates in a kit, as a strip of thumbnails. */
export function KitFlowStrip({ kitId, goal, width = 150 }: { kitId: string; goal: KitGoal; width?: number }) {
  return (
    <ol className="flex flex-wrap gap-2.5">
      {KIT_FLOWS[goal].steps.map((kind, i) => (
        <li key={kind} className="overflow-hidden rounded-lg border border-slate-200 bg-white" style={{ width }}>
          <DocThumb html={kitPagePreview(kitId, kind)} width={width - 2} ratio={0.78} />
          <span className="block truncate border-t border-slate-100 px-2 py-1 text-[11px] font-medium text-slate-600">
            {i + 1}. {KIT_PAGES[kind].stepName}
          </span>
        </li>
      ))}
    </ol>
  );
}

export type EmailChoice = { kit: string; kind: KitEmailKind } | null;
/** Content (and proposed subject) of a chosen email template; null = the plain default email. */
export const emailChoiceContent = (c: EmailChoice) => (c ? kitEmail(c.kit, c.kind) : null);

/** Email template choice: a kit (the account's kit first), then one of its emails — or a plain email. */
export function EmailTemplatePicker({ value, onChange, preferred }: { value: EmailChoice; onChange: (c: EmailChoice) => void; preferred: string | null }) {
  const kits = useMemo(() => (preferred ? [...KITS].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred)) : KITS), [preferred]);
  const [kitId, setKitId] = useState<string>(value?.kit ?? kits[0]!.id);
  // the account's kit arrives after the first render: show it unless the user already chose something
  useEffect(() => {
    if (preferred && !value) setKitId(preferred);
  }, [preferred]); // eslint-disable-line react-hooks/exhaustive-deps
  const kit = kits.find((k) => k.id === kitId) ?? kits[0]!;
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-700">Modèle</p>
      <div role="tablist" aria-label="Kit" className="mb-3 flex flex-wrap gap-1.5">
        {kits.map((k) => (
          <button
            key={k.id}
            type="button"
            role="tab"
            aria-selected={k.id === kit.id}
            data-kit-tab={k.id}
            onClick={() => setKitId(k.id)}
            className={cx(
              'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors',
              k.id === kit.id ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
            )}
          >
            <span className="h-3 w-3 rounded-full ring-1 ring-white/40" style={{ background: k.tokens.accent }} />
            {k.name}
            {preferred === k.id && <span className={cx('text-[10px] font-normal', k.id === kit.id ? 'text-slate-300' : 'text-brand-600')}>votre kit</span>}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Option active={!value} onClick={() => onChange(null)} label="Email simple" hint="Du texte, sans mise en page.">
          <span className="flex h-[150px] items-center justify-center bg-slate-50 text-slate-300">
            <FileText size={32} />
          </span>
        </Option>
        {KIT_EMAIL_KINDS.map((kind) => (
          <Option
            key={kind}
            active={value?.kit === kit.id && value.kind === kind}
            onClick={() => onChange({ kit: kit.id, kind })}
            label={KIT_EMAILS[kind].name}
            hint={KIT_EMAILS[kind].description}
            data={`${kit.id}:${kind}`}
          >
            <DocThumb html={kitEmailPreview(kit.id, kind)} width={196} docWidth={640} ratio={0.765} />
          </Option>
        ))}
      </div>
    </div>
  );
}

function Option({ active, onClick, label, hint, children, data }: { active: boolean; onClick: () => void; label: string; hint: string; children: React.ReactNode; data?: string }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      data-email-template={data ?? 'plain'}
      onClick={onClick}
      className={cx('overflow-hidden rounded-lg border-2 bg-white text-left transition-all', active ? 'border-brand-500 ring-4 ring-brand-500/10' : 'border-slate-200 hover:border-slate-300')}
    >
      <span className="flex justify-center overflow-hidden border-b border-slate-100 bg-slate-50">{children}</span>
      <span className="block px-2.5 py-2">
        <span className="block text-xs font-semibold text-slate-800">{label}</span>
        <span className="block text-[11px] leading-snug text-slate-500">{hint}</span>
      </span>
    </button>
  );
}

// Small pieces shared by the OAuth screens (consent, connected apps, developers).
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { OAUTH_SCOPE_INFO, type OAuthScope } from '@scalo/shared';
import { copyText } from '../../lib/hooks';
import { cx } from '../../components/ui';
import { initials } from '../../lib/format';

/** Application logo (https URL, loaded without referrer) or its initials. */
export function AppLogo({ name, url, size = 40 }: { name: string; url?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  const style = { width: size, height: size };
  if (url && !broken) {
    return <img src={url} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} style={style} className="shrink-0 rounded-xl border border-slate-200 bg-white object-cover" />;
  }
  return (
    <span style={{ ...style, fontSize: Math.round(size * 0.36) }} className="flex shrink-0 items-center justify-center rounded-xl bg-slate-900 font-semibold text-white">
      {initials(name) || '?'}
    </span>
  );
}

export const scopeLabel = (s: string) => OAUTH_SCOPE_INFO[s as OAuthScope]?.label ?? s;

/** Monospace value with a copy button. */
export function CopyValue({ value, className, secret }: { value: string; className?: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx('flex min-w-0 items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 py-1 pr-1 pl-3', secret && 'border-amber-300 bg-amber-50', className)}>
      <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-slate-800" title={value}>
        {value}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(value)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900"
        aria-label="Copier"
      >
        {copied ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        {copied ? 'Copié' : 'Copier'}
      </button>
    </div>
  );
}

/** Multi-line code sample with a copy button. */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={cx('group relative', className)}>
      <pre className="scalo-scroll overflow-x-auto rounded-lg bg-slate-900 p-4 pr-20 font-mono text-[12.5px] leading-relaxed text-slate-100">{code}</pre>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(code)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="absolute top-2 right-2 inline-flex h-7 items-center gap-1 rounded-md bg-white/10 px-2 text-xs font-medium text-slate-200 hover:bg-white/20"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copié' : 'Copier'}
      </button>
    </div>
  );
}

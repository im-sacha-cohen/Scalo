// Discreet AI button for text fields of the builder: rephrase, shorten, make more persuasive, translate.
import { useState } from 'react';
import { Link } from 'react-router';
import { Sparkles } from 'lucide-react';
import { Spinner, cx } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { AI_LANGUAGE_LABELS, aiApi, type AiLanguage, type AiRewriteAction } from '../../lib/ai-api';

const ACTIONS: { id: AiRewriteAction; label: string }[] = [
  { id: 'rephrase', label: 'Reformuler' },
  { id: 'shorten', label: 'Raccourcir' },
  { id: 'persuasive', label: 'Plus persuasif' },
];

/**
 * `value` is the stored text (rich HTML or plain); `onChange` receives the rewritten plain text. The previous text is
 * restored with the builder's undo (Ctrl+Z) or the "Annuler" link shown after a rewrite.
 */
export function AiRewrite({ value, onChange, className }: { value: string; onChange: (text: string) => void; className?: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previous, setPrevious] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);

  const run = async (action: AiRewriteAction, language?: AiLanguage) => {
    if (!value.trim()) return;
    setBusy(true);
    setNeedsKey(false);
    try {
      const { text } = await aiApi.rewrite({ text: value.slice(0, 5000), action, language });
      if (text) {
        setPrevious(value);
        onChange(text);
      }
      setOpen(false);
    } catch (e) {
      // 409 = no key configured (or unusable key): explain where to set it instead of a bare error
      if (e instanceof ApiError && e.status === 409) setNeedsKey(true);
      else toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const chip = 'rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50';
  return (
    <div className={cx('mt-1.5', className)}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          disabled={!value.trim()}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-400 transition-colors hover:text-brand-600 disabled:pointer-events-none disabled:opacity-50"
        >
          <Sparkles size={12} /> Améliorer avec l’IA
        </button>
        {previous !== null && !busy && (
          <button
            type="button"
            className="text-xs text-slate-400 underline hover:text-slate-700"
            onClick={() => {
              onChange(previous);
              setPrevious(null);
            }}
          >
            Annuler la réécriture
          </button>
        )}
        {busy && <Spinner size={12} />}
      </div>
      {open && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {ACTIONS.map((a) => (
              <button key={a.id} type="button" disabled={busy} className={chip} onClick={() => run(a.id)}>
                {a.label}
              </button>
            ))}
            <select
              aria-label="Traduire"
              disabled={busy}
              value=""
              onChange={(e) => e.target.value && run('translate', e.target.value as AiLanguage)}
              className={cx(chip, 'cursor-pointer pr-1')}
            >
              <option value="">Traduire…</option>
              {(Object.keys(AI_LANGUAGE_LABELS) as AiLanguage[]).map((l) => (
                <option key={l} value={l}>
                  {AI_LANGUAGE_LABELS[l]}
                </option>
              ))}
            </select>
          </div>
          {needsKey ? (
            <p className="mt-2 text-xs text-amber-800">
              Aucune clé API Claude utilisable. Ajoutez la vôtre dans{' '}
              <Link to="/settings#ia" className="font-semibold underline">
                Paramètres → IA
              </Link>
              .
            </p>
          ) : (
            <p className="mt-1.5 text-[11px] text-slate-400">Le texte est réécrit sans mise en forme (gras, liens). Ctrl+Z pour revenir en arrière.</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Subject ideas for the A/B test of a newsletter: fills the variants with the picked suggestions. */
export function AiSubjectIdeas({ subject, content, onPick }: { subject: string; content?: string; onPick: (subjects: string[]) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [needsKey, setNeedsKey] = useState(false);

  const load = async () => {
    setBusy(true);
    setNeedsKey(false);
    try {
      const { subjects } = await aiApi.subjects({ subject, content: content?.slice(0, 6000), count: 4 });
      setIdeas(subjects);
      setPicked([]);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setNeedsKey(true);
      else toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (s: string) => {
    const next = picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s].slice(-2);
    setPicked(next);
    onPick(next);
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-600">Besoin d’idées ? L’IA propose des objets à tester (choisissez-en jusqu’à 2).</p>
        <button type="button" onClick={load} disabled={busy || !subject.trim()} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700 disabled:opacity-50">
          {busy ? <Spinner size={12} /> : <Sparkles size={12} />} {ideas.length ? 'Autres idées' : 'Proposer des objets'}
        </button>
      </div>
      {needsKey && (
        <p className="mt-2 text-xs text-amber-800">
          Aucune clé API Claude utilisable. Ajoutez la vôtre dans{' '}
          <Link to="/settings#ia" className="font-semibold underline">
            Paramètres → IA
          </Link>
          .
        </p>
      )}
      {ideas.length > 0 && (
        <ul className="mt-2 space-y-1">
          {ideas.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => toggle(s)}
                aria-pressed={picked.includes(s)}
                className={cx('w-full rounded-lg border px-3 py-1.5 text-left text-sm transition-colors', picked.includes(s) ? 'border-brand-500 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50')}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

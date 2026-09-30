// "Bien démarrer": the getting-started checklist of the dashboard. Every tick comes from the server, computed from the
// account's real data (GET /api/onboarding) — there is nothing to tick by hand here.
import { Link } from 'react-router';
import { ArrowRight, Check, EyeOff } from 'lucide-react';
import type { OnboardingState } from '@scalo/shared';
import { Button, cx } from '../../components/ui';

export function StartChecklist({ state, onHide, hiding }: { state: OnboardingState; onHide: () => void; hiding: boolean }) {
  const { items, done, total, complete } = state.checklist;
  const next = items.find((i) => !i.done);
  const minutes = items.filter((i) => !i.done).reduce((n, i) => n + i.minutes, 0);

  return (
    <section aria-labelledby="start-title" className="mb-6 overflow-hidden rounded-3xl border border-brand-200 bg-white">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-7 sm:pt-6">
        <div className="min-w-0">
          <h2 id="start-title" className="text-xl font-extrabold tracking-[-0.025em] text-ink">
            Bien démarrer
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            {complete ? (
              'Tout est en place. Cette liste a fait son travail.'
            ) : (
              <>
                <span className="font-semibold text-ink tabular-nums">
                  {done} sur {total}
                </span>{' '}
                {done > 1 ? 'étapes terminées' : 'étape terminée'} · environ {minutes} min pour le reste
              </>
            )}
          </p>
        </div>
        {state.can_edit && (
          <Button variant="ghost" size="sm" icon={EyeOff} onClick={onHide} loading={hiding} title="Masquer la liste (vous la retrouverez dans le menu de votre compte)">
            Masquer
          </Button>
        )}
      </div>

      {/* one pill per step, like the marks of a staircase */}
      <div
        role="progressbar"
        aria-label="Progression de la mise en route"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={`${done} sur ${total} étapes terminées`}
        className="mt-4 flex gap-1.5 px-5 sm:px-7"
      >
        {items.map((it) => (
          <span key={it.id} className={cx('h-1.5 flex-1 rounded-full transition-colors duration-500', it.done ? 'bg-brand-500' : 'bg-brand-100')} />
        ))}
      </div>

      <ol className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
        {items.map((it) => {
          const isNext = it.id === next?.id;
          return (
            <li key={it.id}>
              <Link
                to={it.href}
                className={cx(
                  'group flex items-center gap-4 px-5 py-3.5 outline-none transition-colors focus-visible:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-inset sm:px-7',
                  isNext ? 'bg-brand-50/70 hover:bg-brand-50' : 'hover:bg-slate-50',
                )}
              >
                <span
                  className={cx(
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                    it.done ? 'bg-brand-500 text-white' : isNext ? 'border-2 border-brand-500' : 'border-2 border-slate-200',
                  )}
                  aria-hidden="true"
                >
                  {it.done ? <Check size={13} strokeWidth={3} /> : isNext ? <span className="h-2 w-2 rounded-full bg-brand-500" /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cx('block text-sm', it.done ? 'text-slate-400 line-through decoration-slate-300' : 'font-semibold text-ink')}>
                    {it.title}
                    <span className="sr-only">{it.done ? ' — fait' : ' — à faire'}</span>
                  </span>
                  {isNext && <span className="mt-0.5 block text-sm leading-snug text-slate-600">{it.description}</span>}
                </span>
                {it.done ? (
                  <span className="shrink-0 text-xs font-medium text-slate-400" aria-hidden="true">
                    Fait
                  </span>
                ) : (
                  <>
                    <span className="shrink-0 font-mono text-[11px] text-slate-500 tabular-nums">{it.minutes} min</span>
                    {isNext ? (
                      <span className="hidden h-8 shrink-0 items-center gap-1.5 rounded-full bg-brand-500 px-3.5 text-sm font-semibold text-white transition-colors group-hover:bg-brand-600 sm:inline-flex">
                        Commencer <ArrowRight size={14} />
                      </span>
                    ) : (
                      <ArrowRight size={15} className="hidden shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-brand-600 sm:block" />
                    )}
                  </>
                )}
              </Link>
            </li>
          );
        })}
      </ol>

      {/* the owner skipped the welcome flow: it can still be taken */}
      {!state.member && !state.completed_at && !state.checklist.items.find((i) => i.id === 'funnel')?.done && (
        <p className="border-t border-slate-100 px-5 py-3 text-sm text-slate-500 sm:px-7">
          Vous préférez être guidé ?{' '}
          <Link to="/welcome" className="font-semibold text-brand-600 hover:underline">
            Reprendre la mise en route pas à pas
          </Link>
        </p>
      )}
    </section>
  );
}

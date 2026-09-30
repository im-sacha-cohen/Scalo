// Welcome flow of a new account (/welcome): full screen, no sidebar. Four steps — goal, business, first funnel,
// "it is online" — saved on the server as the owner moves, so the flow resumes where it stopped. "Passer" is always
// one click away and remembered: nobody is kept here.
import { useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import type { OnboardingGoal, OnboardingState, OnboardingStep, Settings } from '@scalo/shared';
import { api } from '../../lib/api';
import { aiApi } from '../../lib/ai-api';
import { useAuth } from '../../lib/auth';
import { useLoad } from '../../lib/hooks';
import { markOnboardingSettled, onboardingApi } from '../../lib/onboarding-api';
import { Logo } from '../../components/Layout';
import { useToast } from '../../components/Toast';
import { Button, cx, ErrorState, Spinner } from '../../components/ui';
import { FLOW, Stairs, StairsCompact, stepIndex } from './parts';
import { BusinessStep, FunnelStep, GoalStep, LiveStep, type BusinessDraft } from './steps';

const ASIDE: Record<OnboardingStep, string> = {
  goal: 'Trois minutes, quatre marches. À l’arrivée : une page publiée, avec sa propre adresse.',
  business: 'Un email signé d’un nom connu est plus souvent ouvert. L’adresse postale en pied d’email, elle, est une obligation légale.',
  funnel: 'Un tunnel est une suite de pages : on s’inscrit, on découvre l’offre, on est remercié. Chaque page se modifie ensuite à la souris.',
  live: 'Visiteur, inscrit, client : chaque marche se mesure désormais dans votre tableau de bord.',
};

export function WelcomePage() {
  const { data, error, reload } = useLoad(async () => {
    const [state, settings, ai] = await Promise.all([onboardingApi.get(), api.settings(), aiApi.status().catch(() => null)]);
    return { state, settings, aiReady: !!ai?.configured };
  }, []);

  if (error && !data) {
    return (
      <div className="mx-auto flex min-h-full max-w-md flex-col justify-center gap-4 p-6">
        <ErrorState message={error} onRetry={reload} />
        <a href="/dashboard" className="text-center text-sm font-medium text-brand-600 hover:underline">
          Aller au tableau de bord
        </a>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center bg-white" role="status" aria-label="Chargement">
        <Spinner size={32} />
      </div>
    );
  }
  // team members never go through the flow; an account that finished it has nothing left to do here
  if (data.state.member || data.state.completed_at) return <Navigate to="/dashboard" replace />;
  return <Flow initial={data.state} settings={data.settings} aiReady={data.aiReady} />;
}

function Flow({ initial, settings, aiReady }: { initial: OnboardingState; settings: Settings; aiReady: boolean }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [state, setState] = useState(initial);
  // a goal is needed by every later step: without one, start there whatever was saved
  const [step, setStep] = useState<OnboardingStep>(initial.goal ? initial.step : 'goal');
  const [dir, setDir] = useState<'forward' | 'back'>('forward');
  const [goal, setGoal] = useState<OnboardingGoal | null>(initial.goal);
  const [draft, setDraft] = useState<BusinessDraft>({ name: settings.sender_name, email: settings.sender_email || user?.email || '', address: settings.company_address });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  const i = stepIndex(step);
  const meta = FLOW[i]!;

  // step change: start at the top, focus on the heading (not on the very first render: the page has just loaded)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [step]);

  useEffect(() => {
    const prev = document.title;
    document.title = `${meta.label} — Bienvenue sur Scalo`;
    return () => {
      document.title = prev;
    };
  }, [meta.label]);

  const go = (to: OnboardingStep, save = true) => {
    setError(null);
    setDir(stepIndex(to) < stepIndex(step) ? 'back' : 'forward');
    setStep(to);
    // best effort: if the request fails the flow goes on, the position is simply not remembered
    if (save) onboardingApi.update({ step: to }).then(setState, () => undefined);
  };

  const skip = async () => {
    setLeaving('skip');
    try {
      await onboardingApi.update({ skip: true });
      if (user) markOnboardingSettled(user.id);
      navigate('/dashboard', { replace: true });
    } catch (e) {
      toast.error(e);
      setLeaving(null);
    }
  };

  const saveGoal = async () => {
    if (!goal) return;
    go('business', false);
    try {
      setState(await onboardingApi.update({ goal, step: 'business' }));
    } catch (e) {
      toast.error(e);
    }
  };

  const saveBusiness = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.saveSettings({ sender_name: draft.name.trim(), sender_email: draft.email.trim(), company_address: draft.address.trim() });
      go('funnel');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const funnelCreated = async (funnelId: number, msg?: string) => {
    const next = await onboardingApi.update({ funnel_id: funnelId, step: 'live' });
    setState(next);
    setNotice(msg ?? null);
    go('live', false);
  };

  const finish = async (to: string) => {
    setLeaving(to);
    try {
      await onboardingApi.update({ complete: true });
      if (user) markOnboardingSettled(user.id);
      navigate(to, { replace: true });
    } catch (e) {
      toast.error(e);
      setLeaving(null);
    }
  };

  const live = step === 'live' && !!state.funnel;
  const canBack = i > 0 && !live;
  const skipButton = (tone: string) =>
    !live && (
      <button
        type="button"
        onClick={skip}
        disabled={!!leaving}
        title="Passer la mise en route et aller au tableau de bord"
        className={cx('rounded-full px-3 py-1.5 text-sm font-medium outline-none transition-colors focus-visible:ring-4 disabled:opacity-50', tone)}
      >
        Passer
      </button>
    );

  return (
    <div className="flex min-h-full flex-col bg-white lg:flex-row">
      {/* ---- rail (desktop): the staircase ---- */}
      <aside className="sticky top-0 hidden h-screen w-[400px] shrink-0 flex-col justify-between overflow-hidden bg-ink p-10 text-white lg:flex">
        <Logo dark />
        <div>
          <p className="mb-6 font-mono text-[11px] tracking-[0.14em] text-brand-300 uppercase">Mise en route</p>
          <Stairs current={step} onGo={go} locked={live} />
        </div>
        {/* fixed height: the staircase must not move when the text below changes */}
        <p key={step} className="onb-fade flex h-24 max-w-[30ch] items-end text-sm leading-relaxed text-brand-200">
          <span>{ASIDE[step]}</span>
        </p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ---- header (mobile) ---- */}
        <header className="bg-ink px-5 pt-4 pb-5 text-white lg:hidden">
          <div className="flex items-center justify-between">
            <Logo dark />
            {skipButton('-mr-3 text-brand-200 hover:text-white focus-visible:ring-white/30')}
          </div>
          <div className="mt-4 flex items-end justify-between gap-4">
            <p className="text-sm font-medium text-brand-100">
              <span className="font-mono text-xs text-brand-300">
                {i + 1}/{FLOW.length}
              </span>{' '}
              · {meta.short}
            </p>
            <StairsCompact current={step} />
          </div>
        </header>

        {/* ---- toolbar ---- */}
        <div className={cx('items-center justify-between px-3 sm:px-8 lg:flex lg:h-[72px] lg:px-12', canBack ? 'flex h-14' : 'hidden')}>
          {canBack ? (
            <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => go(FLOW[i - 1]!.id)}>
              Retour
            </Button>
          ) : (
            <span />
          )}
          <div className="hidden items-center gap-3 lg:flex">
            <p className="font-mono text-xs text-slate-400">
              Étape {i + 1} sur {FLOW.length}
            </p>
            {skipButton('text-slate-500 hover:bg-slate-100 hover:text-ink focus-visible:ring-brand-500/25')}
          </div>
        </div>

        <p className="sr-only" role="status" aria-live="polite">
          Étape {i + 1} sur {FLOW.length} : {meta.label}
        </p>

        <main className={cx('flex-1 px-5 pb-16 sm:px-10 lg:px-14 lg:pt-[3vh]', canBack ? 'pt-2' : 'pt-8')}>
          {step === 'goal' && <GoalStep key="goal" value={goal} onChange={setGoal} onNext={saveGoal} dir={dir} headingRef={heading} />}
          {step === 'business' && <BusinessStep key="business" draft={draft} onChange={setDraft} onNext={saveBusiness} saving={saving} error={error} dir={dir} headingRef={heading} />}
          {(step === 'funnel' || (step === 'live' && !state.funnel)) && goal && (
            <FunnelStep key="funnel" goal={goal} business={draft.name} aiReady={aiReady} importStarted={state.import_started} onCreated={funnelCreated} dir={dir} headingRef={heading} />
          )}
          {live && state.funnel && (
            <LiveStep
              key="live"
              funnel={state.funnel}
              notice={notice}
              remaining={state.checklist.total - state.checklist.done}
              finishing={leaving}
              onFinish={finish}
              headingRef={heading}
            />
          )}
        </main>
      </div>
    </div>
  );
}

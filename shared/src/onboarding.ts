// Onboarding of a new account: welcome flow (/welcome) and "Bien démarrer" checklist of the dashboard.
// State and checklist are served by GET /api/onboarding (the checklist is computed from the account's real data).

export const ONBOARDING_GOALS = ['leads', 'sell', 'course', 'migrate'] as const;
/** What the account wants to do first: personalizes the first funnel template and the checklist. */
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_STEPS = ['goal', 'business', 'funnel', 'live'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/** Funnel template (key of FUNNEL_TEMPLATES) proposed for a goal. */
export const ONBOARDING_TEMPLATE: Record<OnboardingGoal, 'optin' | 'sales'> = {
  leads: 'optin',
  sell: 'sales',
  course: 'sales',
  migrate: 'optin',
};

/**
 * Kits (shared/kits) proposed at the « Votre premier tunnel » step for a goal: a short visual choice, not a catalog.
 * The first one is preselected.
 */
export const ONBOARDING_KITS: Record<OnboardingGoal, string[]> = {
  leads: ['cabinet', 'douceur', 'revue', 'marche'],
  sell: ['orbit', 'studio', 'nocturne', 'marche'],
  course: ['studio', 'cabinet', 'douceur', 'scene'],
  migrate: ['cabinet', 'orbit', 'studio', 'douceur'],
};

export type OnboardingItemId =
  | 'sender'
  | 'funnel'
  | 'visitor'
  | 'sending'
  | 'contacts'
  | 'first_email'
  | 'stripe'
  | 'product'
  | 'course'
  | 'import';

export interface OnboardingItem {
  id: OnboardingItemId;
  /** Benefit-oriented label. */
  title: string;
  description: string;
  /** Estimated duration, in minutes. */
  minutes: number;
  /** App route of the screen where the step is done. */
  href: string;
  /** Computed from the account's data, never ticked by hand. */
  done: boolean;
}

export interface OnboardingChecklist {
  items: OnboardingItem[];
  done: number;
  total: number;
  complete: boolean;
  /** Hidden by the account ("Masquer"); can be reopened. */
  hidden: boolean;
}

export interface OnboardingFunnel {
  id: number;
  name: string;
  slug: string;
  /** First step of the funnel (the page opened by the public URL), if any. */
  step_id: number | null;
}

export interface OnboardingState {
  /** True while the account owner has neither finished nor skipped the welcome flow. Always false for a team member. */
  required: boolean;
  /** The signed-in person is a team member acting for the account (Enterprise edition): never sees the welcome flow. */
  member: boolean;
  /** The signed-in person may hide / reopen the checklist (false for a read-only member). */
  can_edit: boolean;
  goal: OnboardingGoal | null;
  step: OnboardingStep;
  /** The funnel created during the welcome flow, while it exists. */
  funnel: OnboardingFunnel | null;
  /** An import has been started from the migration screen. */
  import_started: boolean;
  completed_at: string | null;
  skipped_at: string | null;
  checklist: OnboardingChecklist;
}

export interface OnboardingUpdate {
  goal?: OnboardingGoal;
  step?: OnboardingStep;
  funnel_id?: number;
  complete?: true;
  skip?: true;
  checklist_hidden?: boolean;
}

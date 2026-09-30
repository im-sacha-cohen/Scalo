// Onboarding endpoints (/api/onboarding): welcome flow state + "Bien démarrer" checklist computed by the server.
import type { OnboardingState, OnboardingUpdate } from '@scalo/shared';
import { request } from './api';

export const onboardingApi = {
  get: () => request<OnboardingState>('GET', '/onboarding'),
  update: (b: OnboardingUpdate) => request<OnboardingState>('PUT', '/onboarding', b),
};

/* The dashboard waits for the onboarding state before rendering only until it knows, once, that this browser's
   account has nothing to go through: afterwards it renders immediately (the state is still refreshed). */
const SETTLED_KEY = 'scalo_onboarding_settled';

export const onboardingSettled = (userId: number) => {
  try {
    return localStorage.getItem(SETTLED_KEY) === String(userId);
  } catch {
    return false;
  }
};

export const markOnboardingSettled = (userId: number) => {
  try {
    localStorage.setItem(SETTLED_KEY, String(userId));
  } catch {
    /* private mode: the dashboard simply waits for the state each time */
  }
};

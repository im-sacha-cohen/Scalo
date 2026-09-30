// Extension registry of the Enterprise edition (web).
//
// This file is the ONLY module of the web app that knows about the optional `ee/` directory (commercial license,
// see ee/LICENSE). `import.meta.glob` resolves to an empty object when the directory does not exist, so the app
// builds and runs with `ee/` deleted; nothing else imports it. (`index.css` also lists the directory as a Tailwind
// source, which is a no-op when it is missing.) `VITE_SCALO_DISABLE_EE=1` ignores the directory even when present.
import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { RouteObject } from 'react-router';

export interface EeSettingsSection {
  id: string;
  label: string;
  icon: LucideIcon;
  Component: ComponentType;
}

/** Default export of `ee/web/src/index.tsx`. */
export interface EeWebModule {
  /** Routes reachable without a session (invitation link). */
  publicRoutes: RouteObject[];
  /** Extra sections of the Settings page (license, team, audit log, white label). */
  settingsSections: EeSettingsSection[];
  /** Discreet banner above the pages (license expiration, read-only role). */
  Banner: ComponentType;
}

const modules = import.meta.glob<{ default: EeWebModule }>('../../../ee/web/src/index.tsx', { eager: true });

export const eeWeb: EeWebModule | null = import.meta.env.VITE_SCALO_DISABLE_EE ? null : (Object.values(modules)[0]?.default ?? null);

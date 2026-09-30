// Extension registry of the Enterprise edition.
//
// This file is the ONLY place of the core API that knows about the optional `ee/` directory (commercial license, see
// ee/LICENSE). The core never imports `ee/` statically: the entry point is loaded at runtime if — and only if — it
// exists, so the core compiles, passes its tests and runs with the directory deleted (`npm run check:core`).
// `SCALO_DISABLE_EE=1` ignores the directory even when it is present.
//
// Nothing here imports the rest of the core (no cycle with util.ts / db): only types and node built-ins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Request, RequestHandler, Response } from 'express';
import type { AccountRole, EditionInfo } from '@scalo/shared';

/** The mention shown at the bottom of public pages and emails. `hidden` removes it, `text` / `url` replace it. */
export interface PoweredBy {
  hidden: boolean;
  text?: string;
  url?: string;
}

/** What `ee/api/src/index.ts` must return from its exported `register()`. */
export interface EeApi {
  /** Session user → the account he acts for. null: his own account (owner). May throw an HttpError (403). */
  resolveActor(userId: number): Promise<{ accountId: number; role: AccountRole } | null>;
  /** Routes mounted under /api before authentication (invitation acceptance). Must call next() for unknown paths. */
  publicRouter: RequestHandler;
  /** Routes mounted under /api after authentication and the role check. Must call next() for unknown paths. */
  router: RequestHandler;
  /** Called for every authenticated API request, before the role check (audit trail). Must never throw. */
  onRequest(req: Request, res: Response): void;
  /** White label of public pages and emails for an account. null: default mention. Synchronous (in-memory). */
  poweredBy(accountId: number): PoweredBy | null;
  /** License state, active features and admin branding of an account. */
  edition(accountId: number): Pick<EditionInfo, 'license' | 'features' | 'branding'>;
  /** Periodic housekeeping (audit log retention, expired invitations). */
  cleanup(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(here, '../../ee/api/src/index.ts');

export const eeDisabled = () => ['1', 'true', 'yes'].includes((process.env.SCALO_DISABLE_EE ?? '').toLowerCase());

let loading: Promise<EeApi | null> | null = null;
let loaded: EeApi | null = null;

/** Loads the Enterprise extension once (memoized). Resolves to null in the community edition. */
export function loadEe(): Promise<EeApi | null> {
  loading ??= (async () => {
    if (eeDisabled() || !fs.existsSync(ENTRY)) return null;
    // computed specifier: neither TypeScript nor a bundler follows it, the core never depends on ee/ at build time
    const mod = (await import(pathToFileURL(ENTRY).href)) as { register: () => Promise<EeApi> };
    loaded = await mod.register();
    return loaded;
  })();
  return loading;
}

/** The extension if it is already loaded (synchronous code paths: email footer). */
export const ee = (): EeApi | null => loaded;

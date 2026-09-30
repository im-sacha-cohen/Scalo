// Form of a developer application (create / edit).
import { useState, type FormEvent } from 'react';
import { OAUTH_SCOPES, OAUTH_SCOPE_INFO, type OAuthClientType, type OAuthScope } from '@scalo/shared';
import type { DeveloperAppInput } from '../../lib/api';
import { Button, cx, Field, Input, Textarea } from '../../components/ui';

export const TEST_CALLBACK = `${window.location.origin}/oauth/test-callback`;

export interface AppFormValue extends DeveloperAppInput {
  type: OAuthClientType;
}

export const emptyApp = (): AppFormValue => ({
  name: '',
  description: '',
  website: '',
  logo_url: '',
  type: 'confidential',
  redirect_uris: import.meta.env.DEV ? [TEST_CALLBACK] : [],
  scopes: ['profile', 'contacts:read'],
});

/** Client-side check (the API validates again). */
function redirectError(u: string): string | null {
  if (u.includes('#')) return 'fragment (#) interdit';
  if (u.includes('*')) return 'joker (*) interdit';
  try {
    const x = new URL(u);
    if (x.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(x.hostname)) return 'https:// requis (http:// seulement pour localhost)';
    if (['javascript:', 'data:', 'file:'].includes(x.protocol)) return 'schéma interdit';
    return null;
  } catch {
    return 'URL invalide';
  }
}

export function AppForm({
  initial,
  onSubmit,
  submitLabel,
  showType,
  onCancel,
}: {
  initial: AppFormValue;
  onSubmit: (v: AppFormValue) => Promise<void>;
  submitLabel: string;
  showType?: boolean;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<AppFormValue>(initial);
  const [uris, setUris] = useState(initial.redirect_uris.join('\n'));
  const [saving, setSaving] = useState(false);
  const list = uris
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const uriErrors = list.map((u) => [u, redirectError(u)] as const).filter(([, e]) => e);
  const set = <K extends keyof AppFormValue>(k: K, val: AppFormValue[K]) => setV((x) => ({ ...x, [k]: val }));
  const toggleScope = (s: OAuthScope) => set('scopes', v.scopes.includes(s) ? v.scopes.filter((x) => x !== s) : OAUTH_SCOPES.filter((x) => x === s || v.scopes.includes(x)));
  const valid = v.name.trim() && list.length > 0 && list.length <= 10 && !uriErrors.length && v.scopes.length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      await onSubmit({ ...v, name: v.name.trim(), website: v.website?.trim() || null, logo_url: v.logo_url?.trim() || null, redirect_uris: list });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom de l’application" hint="Affiché aux utilisateurs sur l’écran d’autorisation.">
          <Input required maxLength={80} value={v.name} onChange={(e) => set('name', e.target.value)} placeholder="Mon intégration" />
        </Field>
        <Field label="Site web (optionnel)">
          <Input type="url" value={v.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="https://exemple.com" />
        </Field>
      </div>
      <Field label="Description (optionnel)">
        <Textarea rows={2} maxLength={500} value={v.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="Synchronise vos contacts avec…" />
      </Field>
      <Field label="Logo (optionnel)" hint="URL https:// d’une image carrée.">
        <Input type="url" value={v.logo_url ?? ''} onChange={(e) => set('logo_url', e.target.value)} placeholder="https://exemple.com/logo.png" />
      </Field>

      {showType && (
        <div>
          <span className="mb-1.5 block text-sm font-medium text-slate-700">Type d’application</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                ['confidential', 'Confidentielle', 'Serveur (backend) capable de garder un secret : client_secret + PKCE recommandé.'],
                ['public', 'Publique', 'Application web (SPA), mobile ou en ligne de commande : pas de secret, PKCE obligatoire.'],
              ] as const
            ).map(([id, label, desc]) => (
              <button
                key={id}
                type="button"
                onClick={() => set('type', id)}
                className={cx('rounded-lg border p-3 text-left transition-colors', v.type === id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/20' : 'border-slate-200 hover:bg-slate-50')}
              >
                <span className="block text-sm font-medium text-slate-900">{label}</span>
                <span className="mt-0.5 block text-xs text-slate-500">{desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <Field
        label="URL de redirection autorisées"
        error={uriErrors.length ? `${uriErrors[0][0]} : ${uriErrors[0][1]}` : list.length > 10 ? '10 URL maximum' : null}
        hint="Une par ligne, comparaison exacte. https:// obligatoire (http://localhost accepté pour le développement), schéma personnalisé pour les apps mobiles (com.exemple.app:/callback)."
      >
        <Textarea rows={3} value={uris} onChange={(e) => setUris(e.target.value)} className="font-mono text-[13px]" placeholder="https://exemple.com/oauth/callback" spellCheck={false} />
      </Field>
      {import.meta.env.DEV && !list.includes(TEST_CALLBACK) && (
        <button type="button" onClick={() => setUris((u) => `${u.trim() ? `${u.trim()}\n` : ''}${TEST_CALLBACK}`)} className="-mt-3 text-xs font-medium text-brand-600 hover:text-brand-700">
          + Ajouter la page de test locale ({TEST_CALLBACK})
        </button>
      )}

      <div>
        <span className="mb-1.5 block text-sm font-medium text-slate-700">Scopes autorisés</span>
        <p className="mb-2 text-xs text-slate-500">Ce que l’application pourra demander. Chaque utilisateur valide ensuite les scopes demandés.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {OAUTH_SCOPES.map((s) => (
            <label key={s} className={cx('flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5', v.scopes.includes(s) ? 'border-brand-300 bg-brand-50/60' : 'border-slate-200')}>
              <input type="checkbox" className="mt-0.5 accent-brand-600" checked={v.scopes.includes(s)} onChange={() => toggleScope(s)} />
              <span className="min-w-0">
                <span className="block font-mono text-xs font-medium text-slate-800">{s}</span>
                <span className="block text-xs text-slate-500">{OAUTH_SCOPE_INFO[s].description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel}>
            Annuler
          </Button>
        )}
        <Button type="submit" loading={saving} disabled={!valid}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

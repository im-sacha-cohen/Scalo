/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Lock, User as UserIcon } from 'lucide-react';
import { ACCOUNT_ROLE_LABELS } from '@scalo/shared';
import { Logo } from '../../../web/src/components/Layout';
import { Button, Field, Input, Spinner } from '../../../web/src/components/ui';
import { setToken } from '../../../web/src/lib/api';
import { useLoad } from '../../../web/src/lib/hooks';
import { eeApi } from './api';

/** /invite/:token — the invited collaborator chooses his name and password, then lands in the account. */
export function InvitePage() {
  const { token = '' } = useParams();
  const { data, error, loading } = useLoad(() => eeApi.invitation(token), [token]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setSaving(true);
    try {
      const r = await eeApi.acceptInvitation(token, { name: name.trim(), password });
      setToken(r.token);
      window.location.href = '/'; // full reload: the session and the account are loaded from scratch
    } catch (err) {
      setSubmitError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-2xl border border-slate-200/80 bg-white p-6 sm:p-8">
          {loading ? (
            <div className="flex h-32 items-center justify-center">
              <Spinner size={28} />
            </div>
          ) : !data ? (
            <div className="text-center">
              <h1 className="font-display text-xl font-extrabold tracking-[-0.02em] text-ink">Invitation indisponible</h1>
              <p className="mt-2 text-sm text-slate-500">{error ?? 'Cette invitation est introuvable, expirée ou déjà utilisée.'}</p>
              <p className="mt-4 text-sm text-slate-500">
                Demandez un nouveau lien à la personne qui vous a invité, ou{' '}
                <Link to="/login" className="font-semibold text-brand-600 hover:text-brand-700">
                  connectez-vous
                </Link>
                .
              </p>
            </div>
          ) : (
            <>
              <h1 className="font-display text-2xl font-extrabold tracking-[-0.03em] text-ink">Rejoindre {data.account_name}</h1>
              <p className="mt-1.5 text-sm text-slate-500">
                Vous êtes invité avec le rôle « {ACCOUNT_ROLE_LABELS[data.role]} ». Votre identifiant sera <strong className="text-slate-700">{data.email}</strong>.
              </p>
              <form onSubmit={submit} className="mt-6 space-y-4">
                {submitError && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">{submitError}</div>}
                <Field label="Votre nom">
                  <Input icon={UserIcon} required maxLength={100} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Marie Dupont" autoFocus />
                </Field>
                <Field label="Choisissez un mot de passe" hint="8 caractères minimum.">
                  <Input icon={Lock} type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
                </Field>
                <Button type="submit" size="lg" className="w-full" loading={saving}>
                  Accepter l’invitation
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

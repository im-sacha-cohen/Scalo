import { useEffect, useState, type FormEvent } from 'react';
import { Globe, KeyRound, Lock, Shuffle, Tag as TagIcon, UserCheck, type LucideIcon } from 'lucide-react';
import type { Step, StepAccess, StepAccessMode, Tag } from '@scalo/shared';
import { api, type StepAccessInput } from '../../lib/api';
import { Button, cx, Field, Input, Select } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';

const MODES: { id: StepAccessMode; icon: LucideIcon; label: string; desc: string }[] = [
  { id: 'public', icon: Globe, label: 'Publique', desc: 'Tout le monde peut ouvrir la page avec son URL.' },
  { id: 'funnel', icon: UserCheck, label: 'Inscrits du tunnel', desc: 'Seulement les visiteurs qui se sont inscrits via un formulaire de ce tunnel.' },
  { id: 'tag', icon: TagIcon, label: 'Contacts avec un tag', desc: 'Seulement les contacts identifiés qui ont un tag précis (ex. « client »).' },
  { id: 'password', icon: KeyRound, label: 'Mot de passe', desc: 'Le visiteur doit saisir un mot de passe (mémorisé 30 jours).' },
];

export const isProtected = (a?: StepAccess) => !!a && a.mode !== 'public';

export function accessLabel(a?: StepAccess) {
  return MODES.find((m) => m.id === (a?.mode ?? 'public'))?.label ?? 'Publique';
}

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

export function StepAccessModal({ step, onClose, onSaved }: { step: Step | null; onClose: () => void; onSaved: (s: Step) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<StepAccessMode>('public');
  const [tagId, setTagId] = useState<number | ''>('');
  const [redirect, setRedirect] = useState<'first' | 'previous' | 'url'>('first');
  const [redirectUrl, setRedirectUrl] = useState('');
  const [password, setPassword] = useState('');
  const [slug, setSlug] = useState('');
  const [tags, setTags] = useState<Tag[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!step) return;
    const a = step.access ?? { mode: 'public' };
    setMode(a.mode);
    setTagId(a.tag_id ?? '');
    setRedirect(a.redirect ?? 'first');
    setRedirectUrl(a.redirect_url ?? '');
    setPassword('');
    setSlug(step.slug);
    api.tags().then(setTags).catch(() => setTags([]));
  }, [step]);

  if (!step) return null;
  const passwordSet = !!step.access?.password_set;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'tag' && !tagId) return toast.error('Choisissez le tag requis');
    if (mode === 'password' && !passwordSet && password.length < 4) return toast.error('Le mot de passe doit faire au moins 4 caractères');
    const access: StepAccessInput = {
      mode,
      ...(mode === 'tag' ? { tag_id: Number(tagId) } : {}),
      redirect,
      ...(redirect === 'url' ? { redirect_url: redirectUrl.trim() } : {}),
      ...(password ? { password } : {}),
    };
    setSaving(true);
    try {
      const saved = await api.updateStep(step.id, { access, ...(slug.trim() !== step.slug ? { slug: slug.trim() } : {}) });
      toast.success(mode === 'public' ? 'Page publique' : 'Accès protégé enregistré');
      onSaved(saved);
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!step}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Lock size={18} className="text-brand-600" /> Accès à « {step.name} »
        </span>
      }
      description="Contrôlez qui peut ouvrir cette étape, même en connaissant son URL."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="step-access-form" loading={saving}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id="step-access-form" onSubmit={submit} className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cx(
                'flex gap-3 rounded-xl border p-3 text-left transition-colors',
                mode === m.id ? 'border-brand-500 bg-brand-50 ring-2 ring-brand-500/15' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
              )}
            >
              <span className={cx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', mode === m.id ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600')}>
                <m.icon size={17} />
              </span>
              <span>
                <span className="block text-sm font-semibold text-slate-900">{m.label}</span>
                <span className="block text-xs leading-snug text-slate-500">{m.desc}</span>
              </span>
            </button>
          ))}
        </div>

        {mode === 'tag' && (
          <Field label="Tag requis" hint="Le visiteur est reconnu grâce au cookie posé lors de son inscription sur l’un de vos formulaires.">
            <Select value={tagId} onChange={(e) => setTagId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">Choisir un tag…</option>
              {tags.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {mode === 'password' && (
          <Field label={passwordSet ? 'Nouveau mot de passe (laisser vide pour garder l’actuel)' : 'Mot de passe'}>
            <Input type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={passwordSet ? '••••••••' : 'Au moins 4 caractères'} autoComplete="off" />
          </Field>
        )}

        {(mode === 'funnel' || mode === 'tag') && (
          <Field label="Si le visiteur n’a pas accès" hint="Seules les étapes publiques sont proposées, pour éviter les boucles de redirection.">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select value={redirect} onChange={(e) => setRedirect(e.target.value as typeof redirect)} className="sm:w-64">
                <option value="first">Rediriger vers la 1re page publique</option>
                <option value="previous">Rediriger vers l’étape publique précédente</option>
                <option value="url">Rediriger vers une URL…</option>
              </Select>
              {redirect === 'url' && <Input value={redirectUrl} onChange={(e) => setRedirectUrl(e.target.value)} placeholder="https://… ou /p/…" className="flex-1" />}
            </div>
          </Field>
        )}

        <Field
          label="Adresse de la page"
          hint="Une URL difficile à deviner évite qu’on tombe sur la page en tapant /merci ou /offre. À combiner avec une protection ci-dessus."
        >
          <div className="flex gap-2">
            <Input value={slug} onChange={(e) => setSlug(e.target.value)} className="flex-1 font-mono text-sm" />
            <Button type="button" variant="secondary" icon={Shuffle} onClick={() => setSlug(`${step.slug.replace(/-[a-z0-9]{6}$/, '')}-${randomSuffix()}`)}>
              URL secrète
            </Button>
          </div>
        </Field>

        {mode !== 'public' && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Les pages protégées ne sont pas indexées par les moteurs de recherche. Vous pouvez toujours les prévisualiser depuis l’éditeur (lien d’aperçu sécurisé, valable 24 h).
          </p>
        )}
      </form>
    </Modal>
  );
}

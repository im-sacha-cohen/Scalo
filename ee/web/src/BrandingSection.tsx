/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Palette, Stamp } from 'lucide-react';
import { useToast } from '../../../web/src/components/Toast';
import { Button, Card, CardHeader, ErrorState, Field, Input, PageLoader, Toggle } from '../../../web/src/components/ui';
import { useEdition } from '../../../web/src/lib/edition';
import { useLoad } from '../../../web/src/lib/hooks';
import type { Branding } from '../../shared/types';
import { eeApi } from './api';
import { EnterpriseFeatureScreen } from './EnterpriseGate';

type Form = Omit<Branding, 'active'>;
const EMPTY: Form = { hide_powered_by: false, powered_by_text: '', powered_by_url: '', app_name: '', logo_url: '' };

export function BrandingSection() {
  const toast = useToast();
  const edition = useEdition();
  const licensed = edition.has('white_label');
  const { data, setData, error, loading, reload } = useLoad(() => eeApi.branding(), []);
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      const { active: _active, ...rest } = data;
      void _active;
      setForm(rest);
    }
  }, [data]);

  if (!licensed) {
    return (
      <EnterpriseFeatureScreen feature="white_label" icon={Stamp}>
        Retirez ou remplacez la mention « Propulsé par Scalo » de vos pages publiques et de vos emails, et affichez votre nom et votre logo dans l’interface.
      </EnterpriseFeatureScreen>
    );
  }
  if (loading && !data) return <PageLoader />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const readOnly = !edition.isAdmin;
  const dirty = !!data && (Object.keys(EMPTY) as (keyof Form)[]).some((k) => form[k] !== data[k]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setData(await eeApi.saveBranding({ ...form, powered_by_text: form.powered_by_text.trim(), powered_by_url: form.powered_by_url.trim(), app_name: form.app_name.trim(), logo_url: form.logo_url.trim() }));
      await edition.reload();
      toast.success('Marque blanche enregistrée');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card>
        <CardHeader icon={Stamp} title="Mention sur les pages et les emails" description="Par défaut, « Propulsé par Scalo » apparaît discrètement en bas de vos pages publiques et de vos emails." />
        <div className="space-y-4">
          <Toggle checked={form.hide_powered_by} onChange={(v) => set('hide_powered_by', v)} disabled={readOnly} label="Retirer la mention" description="Vos pages et vos emails n’affichent plus aucune référence à Scalo." />
          {!form.hide_powered_by && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Remplacer par" hint="Laissez vide pour conserver la mention par défaut.">
                <Input value={form.powered_by_text} maxLength={80} disabled={readOnly} onChange={(e) => set('powered_by_text', e.target.value)} placeholder="Réalisé par Mon Agence" />
              </Field>
              <Field label="Lien (pages publiques)" hint="Facultatif. Les emails affichent le texte sans lien.">
                <Input type="url" value={form.powered_by_url} disabled={readOnly} onChange={(e) => set('powered_by_url', e.target.value)} placeholder="https://mon-agence.fr" />
              </Field>
            </div>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader icon={Palette} title="Interface d’administration" description="Le nom et le logo affichés dans le menu, pour vous et votre équipe." />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nom">
            <Input value={form.app_name} maxLength={40} disabled={readOnly} onChange={(e) => set('app_name', e.target.value)} placeholder="Mon Agence" />
          </Field>
          <Field label="Logo (URL)" hint="Adresse https:// d’une image, de préférence claire sur fond sombre.">
            <Input value={form.logo_url} disabled={readOnly} onChange={(e) => set('logo_url', e.target.value)} placeholder="https://mon-agence.fr/logo.svg" />
          </Field>
        </div>
      </Card>

      {!readOnly && (
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!dirty}>
            Enregistrer
          </Button>
        </div>
      )}
    </form>
  );
}

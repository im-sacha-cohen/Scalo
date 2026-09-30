// Funnel → "Suivi et RGPD": official pixels (Meta, GA4, GTM), cookie banner, ready-made legal pages + footer links.
import { useEffect, useState, type FormEvent } from 'react';
import { Cookie, FileText, Radar, Scale } from 'lucide-react';
import {
  COOKIE_BANNER_DEFAULTS,
  LEGAL_PAGES,
  TRACKING_ID_PATTERNS,
  type Funnel,
  type FunnelSettings,
  type LegalPageKind,
  type Step,
} from '@scalo/shared';
import { growthApi } from '../../../lib/growth-api';
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea, Toggle } from '../../../components/ui';
import { useToast } from '../../../components/Toast';

const LEGAL_KINDS: LegalPageKind[] = ['mentions', 'privacy', 'cgv'];

export function FunnelTrackingTab({ funnel, onFunnel }: { funnel: Funnel; onFunnel: (f: Funnel) => void }) {
  const toast = useToast();
  const settings = funnel.settings ?? {};
  const steps = funnel.steps ?? [];

  // ---- pixels ----
  const [meta, setMeta] = useState('');
  const [ga4, setGa4] = useState('');
  const [gtm, setGtm] = useState('');
  // ---- cookie banner ----
  const [bannerOn, setBannerOn] = useState(false);
  const [text, setText] = useState('');
  const [accept, setAccept] = useState('');
  const [decline, setDecline] = useState('');
  const [privacyStep, setPrivacyStep] = useState('');
  const [privacyUrl, setPrivacyUrl] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    setMeta(settings.tracking?.meta_pixel_id ?? '');
    setGa4(settings.tracking?.ga4_id ?? '');
    setGtm(settings.tracking?.gtm_id ?? '');
    const b = settings.cookie_banner;
    setBannerOn(!!b?.enabled);
    setText(b?.text ?? '');
    setAccept(b?.accept_label ?? '');
    setDecline(b?.decline_label ?? '');
    setPrivacyStep(b?.privacy_step_id ? String(b.privacy_step_id) : '');
    setPrivacyUrl(b?.privacy_url ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [funnel.id, JSON.stringify(settings)]);

  const metaErr = meta && !TRACKING_ID_PATTERNS.meta_pixel_id.test(meta.trim()) ? 'Uniquement des chiffres (ex. 123456789012345)' : null;
  const ga4Err = ga4 && !TRACKING_ID_PATTERNS.ga4_id.test(ga4.trim().toUpperCase()) ? 'Format G-XXXXXXXXXX' : null;
  const gtmErr = gtm && !TRACKING_ID_PATTERNS.gtm_id.test(gtm.trim().toUpperCase()) ? 'Format GTM-XXXXXXX' : null;

  const save = async (key: string, patch: FunnelSettings) => {
    setSaving(key);
    try {
      const next = await growthApi.saveFunnelSettings(funnel.id, patch);
      onFunnel({ ...funnel, settings: next });
      toast.success('Réglages enregistrés');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(null);
    }
  };

  const savePixels = (e: FormEvent) => {
    e.preventDefault();
    save('pixels', { tracking: { meta_pixel_id: meta.trim(), ga4_id: ga4.trim(), gtm_id: gtm.trim() } });
  };
  const saveBanner = (e: FormEvent) => {
    e.preventDefault();
    save('banner', {
      cookie_banner: {
        enabled: bannerOn,
        text: text.trim(),
        accept_label: accept.trim(),
        decline_label: decline.trim(),
        privacy_step_id: privacyStep ? Number(privacyStep) : null,
        privacy_url: privacyStep ? '' : privacyUrl.trim(),
      },
    });
  };

  // ---- legal pages ----
  const legalIds = settings.legal?.step_ids ?? [];
  const legalSteps = legalIds.map((id) => steps.find((s) => s.id === id)).filter((s): s is Step => !!s);
  const [adding, setAdding] = useState<LegalPageKind | null>(null);
  const addLegal = async (kind: LegalPageKind) => {
    setAdding(kind);
    try {
      const r = await growthApi.addLegalPage(funnel.id, kind);
      onFunnel(r.funnel);
      toast.success(`Page « ${LEGAL_PAGES[kind].name} » ajoutée : complétez les passages [À compléter]`);
    } catch (err) {
      toast.error(err);
    } finally {
      setAdding(null);
    }
  };
  const toggleLegal = (id: number, on: boolean) =>
    save('legal', { legal: { footer: settings.legal?.footer ?? true, step_ids: on ? [...legalIds, id] : legalIds.filter((x) => x !== id) } });

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader
          icon={Radar}
          title="Pixels et statistiques"
          description="Collez uniquement l’identifiant : le code officiel est ajouté à toutes les pages du tunnel (PageView), avec l’événement Lead / generate_lead sur la page qui suit une inscription."
        />
        <form onSubmit={savePixels} className="space-y-4">
          <Field label="Meta Pixel (Facebook / Instagram)" error={metaErr} hint="Gestionnaire d’événements Meta → Sources de données → ID du pixel">
            <Input value={meta} onChange={(e) => setMeta(e.target.value)} placeholder="123456789012345" inputMode="numeric" spellCheck={false} />
          </Field>
          <Field label="Google Analytics 4" error={ga4Err} hint="Admin → Flux de données → ID de mesure">
            <Input value={ga4} onChange={(e) => setGa4(e.target.value)} placeholder="G-XXXXXXXXXX" spellCheck={false} />
          </Field>
          <Field label="Google Tag Manager" error={gtmErr} hint="Identifiant du conteneur, en haut de l’espace de travail">
            <Input value={gtm} onChange={(e) => setGtm(e.target.value)} placeholder="GTM-XXXXXXX" spellCheck={false} />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {bannerOn ? 'Chargés seulement après acceptation du bandeau cookies.' : 'Activez le bandeau cookies pour ne les charger qu’avec le consentement du visiteur.'}
            </p>
            <Button type="submit" loading={saving === 'pixels'} disabled={!!(metaErr || ga4Err || gtmErr)}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          icon={Cookie}
          title="Bandeau cookies"
          description="Demande le consentement avant de charger les pixels. Le choix est mémorisé 6 mois ; « Refuser » est aussi visible qu’« Accepter »."
        />
        <form onSubmit={saveBanner} className="space-y-4">
          <Toggle checked={bannerOn} onChange={setBannerOn} label="Afficher le bandeau cookies" description="Sur toutes les pages du tunnel, tant que le visiteur n’a pas choisi." />
          <Field label="Texte" hint="Votre code personnalisé peut écouter l’événement « scalo:consent » ou lire window.scaloConsent.">
            <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={COOKIE_BANNER_DEFAULTS.text} maxLength={1000} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Bouton « Accepter »">
              <Input value={accept} onChange={(e) => setAccept(e.target.value)} placeholder={COOKIE_BANNER_DEFAULTS.accept_label} maxLength={40} />
            </Field>
            <Field label="Bouton « Refuser »">
              <Input value={decline} onChange={(e) => setDecline(e.target.value)} placeholder={COOKIE_BANNER_DEFAULTS.decline_label} maxLength={40} />
            </Field>
          </div>
          <Field label="Politique de confidentialité">
            <Select value={privacyStep} onChange={(e) => setPrivacyStep(e.target.value)}>
              <option value="">Lien externe (ci-dessous) ou aucun</option>
              {steps.map((s) => (
                <option key={s.id} value={s.id}>
                  Étape : {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {!privacyStep && (
            <Field label="URL de la politique de confidentialité">
              <Input value={privacyUrl} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://mondomaine.fr/confidentialite" type="url" />
            </Field>
          )}
          <div className="flex justify-end">
            <Button type="submit" loading={saving === 'banner'}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Card>

      <Card className="xl:col-span-2">
        <CardHeader
          icon={Scale}
          title="Pages légales"
          description="Modèles rédigés en français, pré-remplis avec l’expéditeur, l’adresse et l’email de vos Paramètres. Relisez-les et complétez les passages [À compléter] : ce sont des points de départ, pas un conseil juridique."
        />
        <div className="grid gap-3 sm:grid-cols-3">
          {LEGAL_KINDS.map((k) => {
            const exists = steps.some((s) => s.name === LEGAL_PAGES[k].name);
            return (
              <div key={k} className="flex flex-col justify-between gap-3 rounded-lg border border-slate-200 p-3">
                <div className="flex items-center gap-2">
                  <FileText size={16} className="text-slate-400" />
                  <span className="text-sm font-medium text-slate-800">{LEGAL_PAGES[k].name}</span>
                  {exists && <Badge tone="green">Ajoutée</Badge>}
                </div>
                <Button variant="secondary" size="sm" loading={adding === k} onClick={() => addLegal(k)}>
                  {exists ? 'Ajouter une autre version' : 'Ajouter au tunnel'}
                </Button>
              </div>
            );
          })}
        </div>
        <div className="mt-5 space-y-3 border-t border-slate-100 pt-4">
          <Toggle
            checked={!!settings.legal?.footer}
            onChange={(v) => save('legal', { legal: { footer: v, step_ids: legalIds } })}
            label="Pied de page avec les liens légaux"
            description="Ajouté en bas de toutes les pages. Ces pages ne sont jamais utilisées comme « étape suivante »."
          />
          {steps.length > 0 && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 pl-12">
              {steps.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={legalIds.includes(s.id)} onChange={(e) => toggleLegal(s.id, e.target.checked)} />
                  {s.name}
                </label>
              ))}
            </div>
          )}
          {legalSteps.length === 0 && <p className="pl-12 text-xs text-slate-500">Aucune page légale sélectionnée.</p>}
        </div>
      </Card>
    </div>
  );
}

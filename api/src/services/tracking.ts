// Funnel settings (funnels.settings): official pixels (Meta, GA4, GTM), cookie banner, legal pages footer.
// Only validated IDs are stored; the snippets are generated here (official code), never taken from user input.
// With the cookie banner enabled, no tracking code is rendered until the visitor accepts (consent cookie, set by a
// plain form POST so it also works without JavaScript and in sandboxed pages).
import { z } from 'zod';
import {
  COOKIE_BANNER_DEFAULTS,
  esc,
  LEGAL_PAGES,
  TRACKING_ID_PATTERNS,
  type CookieBannerSettings,
  type FunnelSettings,
  type FunnelTracking,
} from '@scalo/shared';

const idField = (re: RegExp, message: string, upper: boolean) =>
  z
    .string()
    .trim()
    .max(40)
    .transform((s) => (upper ? s.toUpperCase() : s))
    .refine((s) => s === '' || re.test(s), { message })
    .optional();

export const funnelSettingsInput = z.object({
  tracking: z
    .object({
      meta_pixel_id: idField(TRACKING_ID_PATTERNS.meta_pixel_id, 'Identifiant Meta Pixel invalide : uniquement des chiffres (ex. 123456789012345)', false),
      ga4_id: idField(TRACKING_ID_PATTERNS.ga4_id, 'Identifiant Google Analytics 4 invalide (format G-XXXXXXXXXX)', true),
      gtm_id: idField(TRACKING_ID_PATTERNS.gtm_id, 'Identifiant Google Tag Manager invalide (format GTM-XXXXXXX)', true),
    })
    .strict()
    .optional(),
  cookie_banner: z
    .object({
      enabled: z.boolean(),
      text: z.string().trim().max(1000).optional(),
      accept_label: z.string().trim().max(40).optional(),
      decline_label: z.string().trim().max(40).optional(),
      privacy_step_id: z.number().int().positive().nullable().optional(),
      privacy_url: z
        .string()
        .trim()
        .max(500)
        .refine((s) => s === '' || /^https?:\/\/[^\s"'<>]+$/i.test(s), { message: 'L’URL de la politique de confidentialité doit commencer par http(s)://' })
        .optional(),
    })
    .strict()
    .optional(),
  legal: z.object({ footer: z.boolean(), step_ids: z.array(z.number().int().positive()).max(10) }).strict().optional(),
});
export type FunnelSettingsInput = z.infer<typeof funnelSettingsInput>;

/** Defensive read of the stored settings (every ID re-checked before rendering). */
export function readFunnelSettings(raw: unknown): FunnelSettings {
  const r = funnelSettingsInput.safeParse(raw && typeof raw === 'object' ? raw : {});
  if (!r.success) return {};
  return clean(r.data);
}

/** Drops empty values. */
export function clean(s: FunnelSettingsInput): FunnelSettings {
  const out: FunnelSettings = {};
  if (s.tracking) {
    const t: FunnelTracking = {};
    if (s.tracking.meta_pixel_id) t.meta_pixel_id = s.tracking.meta_pixel_id;
    if (s.tracking.ga4_id) t.ga4_id = s.tracking.ga4_id;
    if (s.tracking.gtm_id) t.gtm_id = s.tracking.gtm_id;
    if (Object.keys(t).length) out.tracking = t;
  }
  if (s.cookie_banner) {
    const b: CookieBannerSettings = { enabled: s.cookie_banner.enabled };
    for (const k of ['text', 'accept_label', 'decline_label', 'privacy_url'] as const) if (s.cookie_banner[k]) b[k] = s.cookie_banner[k];
    if (s.cookie_banner.privacy_step_id) b.privacy_step_id = s.cookie_banner.privacy_step_id;
    out.cookie_banner = b;
  }
  if (s.legal) out.legal = { footer: s.legal.footer, step_ids: [...new Set(s.legal.step_ids)] };
  return out;
}

export const hasTracking = (t?: FunnelTracking) => !!(t && (t.meta_pixel_id || t.ga4_id || t.gtm_id));

// ---------- official snippets ----------

const js = (s: string) => JSON.stringify(s).replace(/</g, '\\u003c'); // IDs are already validated; belt and braces

/** Official snippets for the configured IDs. `lead`: the visitor just opted in (Lead / generate_lead). */
export function trackingSnippets(t: FunnelTracking, lead: boolean): { head: string; body: string } {
  const head: string[] = [];
  const body: string[] = [];
  const meta = t.meta_pixel_id && TRACKING_ID_PATTERNS.meta_pixel_id.test(t.meta_pixel_id) ? t.meta_pixel_id : null;
  const ga4 = t.ga4_id && TRACKING_ID_PATTERNS.ga4_id.test(t.ga4_id) ? t.ga4_id : null;
  const gtm = t.gtm_id && TRACKING_ID_PATTERNS.gtm_id.test(t.gtm_id) ? t.gtm_id : null;
  if (gtm) {
    head.push(
      `<!-- Google Tag Manager --><script>window.dataLayer=window.dataLayer||[];${lead ? "window.dataLayer.push({event:'generate_lead'});" : ''}(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer',${js(gtm)});</script><!-- End Google Tag Manager -->`,
    );
    body.push(`<!-- Google Tag Manager (noscript) --><noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${esc(gtm)}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`);
  }
  if (ga4) {
    head.push(
      `<!-- Google tag (gtag.js) --><script async src="https://www.googletagmanager.com/gtag/js?id=${esc(ga4)}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config',${js(ga4)});${lead ? "gtag('event','generate_lead');" : ''}</script>`,
    );
  }
  if (meta) {
    head.push(
      `<!-- Meta Pixel Code --><script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${js(meta)});fbq('track','PageView');${lead ? "fbq('track','Lead');" : ''}</script><noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${esc(meta)}&amp;ev=PageView&amp;noscript=1"></noscript><!-- End Meta Pixel Code -->`,
    );
  }
  return { head: head.join('\n'), body: body.join('\n') };
}

// ---------- consent ----------

export type Consent = 'granted' | 'denied' | null;
export const CONSENT_COOKIE = 'scalo_consent';
export const CONSENT_MAX_AGE = 182 * 86400_000; // ~6 months

export const readConsent = (v: unknown): Consent => (v === 'granted' || v === 'denied' ? v : null);

/** Exposes the choice to the owner's code: `window.scaloConsent` and a `scalo:consent` event on document (once the DOM is ready). */
export function consentScript(consent: Consent) {
  return `<script>window.scaloConsent=${js(consent ?? 'unknown')};document.addEventListener('DOMContentLoaded',function(){try{document.dispatchEvent(new CustomEvent('scalo:consent',{detail:{status:window.scaloConsent}}))}catch(e){}});</script>`;
}

/** Accessible banner: a region with two equally prominent buttons posting the choice (works without JavaScript). */
export function cookieBannerHtml(b: CookieBannerSettings, action: string, privacyHref: string | null) {
  const text = b.text || COOKIE_BANNER_DEFAULTS.text;
  const accept = b.accept_label || COOKIE_BANNER_DEFAULTS.accept_label;
  const decline = b.decline_label || COOKIE_BANNER_DEFAULTS.decline_label;
  const btn = 'flex:1 1 140px;min-height:44px;padding:10px 18px;border-radius:10px;font-weight:600;font-size:15px;line-height:1.2;font-family:inherit;cursor:pointer;border:2px solid #ffffff';
  return `<div id="scalo-cookie-banner" role="region" aria-label="Gestion des cookies" style="position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483000;max-width:720px;margin:0 auto;background:#0f172a;color:#ffffff;border-radius:14px;padding:18px 20px;box-shadow:0 12px 40px rgba(15,23,42,.35);font:14px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
<p id="scalo-cookie-text" style="margin:0 0 14px">${esc(text)}${privacyHref ? ` <a href="${esc(privacyHref)}" style="color:#ffffff;text-decoration:underline">Politique de confidentialité</a>` : ''}</p>
<form method="post" action="${esc(action)}" style="display:flex;flex-wrap:wrap;gap:10px;margin:0" aria-describedby="scalo-cookie-text">
<button type="submit" name="choice" value="denied" style="${btn};background:transparent;color:#ffffff">${esc(decline)}</button>
<button type="submit" name="choice" value="granted" style="${btn};background:#ffffff;color:#0f172a">${esc(accept)}</button>
</form></div>`;
}

export function legalFooterHtml(links: { label: string; href: string }[]) {
  if (!links.length) return '';
  return `<footer style="text-align:center;padding:24px 16px 32px;font:13px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#64748b">${links
    .map((l) => `<a href="${esc(l.href)}" style="color:inherit;text-decoration:underline;margin:0 8px">${esc(l.label)}</a>`)
    .join('<span aria-hidden="true">·</span>')}</footer>`;
}

/**
 * Server-generated extras of a public page: consent state + official snippets in <head>, legal footer, GTM noscript
 * and cookie banner before </body>. Tracking code is only rendered without banner, or once the visitor accepted.
 */
export function pageExtras(o: {
  settings: FunnelSettings;
  consent: unknown;
  lead: boolean;
  consentAction: string;
  stepHref: (stepId: number) => { name: string; href: string } | null;
}): { headExtra: string; bodyEnd: string } {
  const banner = o.settings.cookie_banner?.enabled ? o.settings.cookie_banner : null;
  const consent = readConsent(o.consent);
  const head: string[] = [];
  const body: string[] = [];
  if (banner) head.push(consentScript(consent));
  if (hasTracking(o.settings.tracking) && (!banner || consent === 'granted')) {
    const s = trackingSnippets(o.settings.tracking!, o.lead);
    head.push(s.head);
    if (s.body) body.push(s.body);
  }
  if (o.settings.legal?.footer) {
    const links = o.settings.legal.step_ids.map((id) => o.stepHref(id)).filter((x): x is { name: string; href: string } => !!x);
    body.push(legalFooterHtml(links.map((l) => ({ label: legalLabel(l.name), href: l.href }))));
  }
  if (banner && consent === null) {
    const privacy = (banner.privacy_step_id && o.stepHref(banner.privacy_step_id)?.href) || banner.privacy_url || null;
    body.push(cookieBannerHtml(banner, o.consentAction, privacy));
  }
  return { headExtra: head.filter(Boolean).join('\n'), bodyEnd: body.filter(Boolean).join('\n') };
}

/** Footer label of a legal step: the known legal page names, otherwise the step name. */
export function legalLabel(stepName: string) {
  const known = Object.values(LEGAL_PAGES).find((p) => p.name === stepName);
  return known?.label ?? stepName;
}

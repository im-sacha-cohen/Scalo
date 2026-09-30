// Native AI endpoints (/api/ai): key, generations (asynchronous, polled), rewrite, subject ideas, usage log.
import { request } from './api';

export type AiLanguage = 'fr' | 'en' | 'es' | 'de' | 'it' | 'pt' | 'nl';
export type AiTone = 'professionnel' | 'chaleureux' | 'direct' | 'expert' | 'enthousiaste';
export type AiGoal = 'capture' | 'vente' | 'webinaire';
export type AiRewriteAction = 'rephrase' | 'shorten' | 'persuasive' | 'translate';
export type AiKind = 'funnel' | 'campaign' | 'newsletter' | 'rewrite' | 'subjects';

export const AI_LANGUAGE_LABELS: Record<AiLanguage, string> = { fr: 'Français', en: 'Anglais', es: 'Espagnol', de: 'Allemand', it: 'Italien', pt: 'Portugais', nl: 'Néerlandais' };
export const AI_TONE_LABELS: Record<AiTone, string> = { professionnel: 'Professionnel', chaleureux: 'Chaleureux', direct: 'Direct', expert: 'Expert', enthousiaste: 'Enthousiaste' };
export const AI_GOAL_LABELS: Record<AiGoal, { label: string; description: string }> = {
  capture: { label: 'Capture d’emails', description: 'Page de capture + remerciement' },
  vente: { label: 'Vente', description: 'Capture, page de vente, remerciement' },
  webinaire: { label: 'Webinaire', description: 'Inscription + confirmation' },
};
export const AI_KIND_LABELS: Record<AiKind, string> = { funnel: 'Tunnel', campaign: 'Campagne', newsletter: 'Newsletter', rewrite: 'Réécriture', subjects: 'Objets d’email' };

export interface AiStatus {
  configured: boolean;
  source: 'account' | 'instance' | null;
  key_hint: string | null;
  key_updated_at: string | null;
  model: string;
  rate_limit: { max: number; window_minutes: number };
}

export interface AiGeneration {
  id: number;
  kind: AiKind;
  status: 'running' | 'done' | 'failed';
  label: string;
  result: { funnel_id?: number; campaign_id?: number; broadcast_id?: number; emails?: number } | null;
  error: string | null;
  model: string | null;
  key_source: 'account' | 'instance';
  input_tokens: number;
  output_tokens: number;
  created_at: string;
  finished_at: string | null;
}

export interface AiUsage {
  last_30_days: { calls: number; input_tokens: number; output_tokens: number };
  items: AiGeneration[];
}

export interface AiBrief {
  offer: string;
  audience?: string;
  tone?: AiTone;
  language?: AiLanguage;
  /** Kit (visual identity) applied to the generated pages / emails. */
  kit?: string;
}

type Started = { id: number; status: 'running' };

export const aiApi = {
  status: () => request<AiStatus>('GET', '/ai/status'),
  saveKey: (api_key: string) => request<AiStatus>('PUT', '/ai/key', { api_key }),
  deleteKey: () => request<AiStatus>('DELETE', '/ai/key'),
  usage: () => request<AiUsage>('GET', '/ai/usage'),
  generation: (id: number) => request<AiGeneration>('GET', `/ai/generations/${id}`),
  generateFunnel: (b: AiBrief & { goal: AiGoal }) => request<Started>('POST', '/ai/funnels', b),
  generateCampaign: (b: AiBrief & { emails: number; link_url?: string }) => request<Started>('POST', '/ai/campaigns', b),
  generateNewsletter: (b: AiBrief & { link_url?: string }) => request<Started>('POST', '/ai/newsletters', b),
  rewrite: (b: { text: string; action: AiRewriteAction; language?: AiLanguage }) => request<{ text: string }>('POST', '/ai/rewrite', b),
  subjects: (b: { subject: string; content?: string; count?: number }) => request<{ subjects: string[] }>('POST', '/ai/subjects', b),
};

/** Polls an asynchronous generation until it is done or failed (throws the readable error when failed). */
export async function waitForGeneration(id: number, signal?: AbortSignal): Promise<AiGeneration> {
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, i < 5 ? 1000 : 2000));
    if (signal?.aborted) throw new DOMException('Annulé', 'AbortError');
    const g = await aiApi.generation(id);
    if (g.status === 'done') return g;
    if (g.status === 'failed') throw new Error(g.error ?? 'La génération a échoué.');
  }
}

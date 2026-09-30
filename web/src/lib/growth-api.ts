// Funnels growth endpoints: custom domains, A/B tests, stats, pixels / cookie banner / legal pages, export / share.
import type {
  CustomDomain,
  Funnel,
  FunnelExport,
  FunnelImportResult,
  FunnelSettings,
  FunnelShareInfo,
  FunnelStats,
  LegalPageKind,
  PageContent,
  SharedFunnelPreview,
  StatsGroup,
  StatsPeriod,
  Step,
  StepAbTest,
  StepVariant,
} from '@scalo/shared';
import { request } from './api';

type Ok = { ok: true };
export type VariantWithContent = StepVariant & { content: PageContent };

export const growthApi = {
  // custom domains
  domains: (funnelId: number) => request<CustomDomain[]>('GET', `/funnels/${funnelId}/domains`),
  addDomain: (funnelId: number, b: { domain: string; root_step_id?: number | null }) => request<CustomDomain>('POST', `/funnels/${funnelId}/domains`, b),
  updateDomain: (id: number, b: { root_step_id: number | null }) => request<CustomDomain>('PATCH', `/domains/${id}`, b),
  verifyDomain: (id: number) => request<CustomDomain>('POST', `/domains/${id}/verify`),
  deleteDomain: (id: number) => request<Ok>('DELETE', `/domains/${id}`),

  // pixels, cookie banner, legal footer
  funnelSettings: (funnelId: number) => request<FunnelSettings>('GET', `/funnels/${funnelId}/settings`),
  saveFunnelSettings: (funnelId: number, b: FunnelSettings) => request<FunnelSettings>('PUT', `/funnels/${funnelId}/settings`, b),
  addLegalPage: (funnelId: number, kind: LegalPageKind) => request<{ step: Step; funnel: Funnel }>('POST', `/funnels/${funnelId}/legal-pages`, { kind }),

  // stats
  funnelStats: (funnelId: number, period: StatsPeriod, group: StatsGroup) => request<FunnelStats>('GET', `/funnels/${funnelId}/stats?period=${period}&group=${group}`),

  // A/B tests
  abTest: (stepId: number) => request<StepAbTest>('GET', `/steps/${stepId}/ab`),
  updateAbTest: (stepId: number, b: { status?: StepAbTest['status']; control_weight?: number }) => request<StepAbTest>('PATCH', `/steps/${stepId}/ab`, b),
  declareWinner: (stepId: number, variant_id: number) => request<StepAbTest>('POST', `/steps/${stepId}/ab/winner`, { variant_id }),
  createVariant: (stepId: number, b: { name?: string; from_variant_id?: number } = {}) => request<VariantWithContent>('POST', `/steps/${stepId}/variants`, b),
  variant: (id: number) => request<VariantWithContent>('GET', `/variants/${id}`),
  updateVariant: (id: number, b: { name?: string; content?: PageContent; weight?: number; active?: boolean }) => request<VariantWithContent>('PATCH', `/variants/${id}`, b),
  deleteVariant: (id: number) => request<Ok>('DELETE', `/variants/${id}`),

  // export / import / share
  exportFunnel: (funnelId: number) => request<FunnelExport>('GET', `/funnels/${funnelId}/export`),
  importFunnel: (data: unknown) => request<FunnelImportResult>('POST', '/funnels/import', data),
  shareInfo: (funnelId: number) => request<FunnelShareInfo>('GET', `/funnels/${funnelId}/share`),
  createShare: (funnelId: number) => request<FunnelShareInfo>('POST', `/funnels/${funnelId}/share`),
  revokeShare: (funnelId: number) => request<FunnelShareInfo>('DELETE', `/funnels/${funnelId}/share`),
  sharedFunnel: (token: string) => request<SharedFunnelPreview>('GET', `/share/${encodeURIComponent(token)}`),
  importShared: (token: string) => request<FunnelImportResult>('POST', `/share/${encodeURIComponent(token)}/import`),
};

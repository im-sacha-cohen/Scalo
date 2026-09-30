// CRM & automations endpoints (custom fields, segments, bulk actions, automations). See SPEC.md « Automatisations et CRM ».
import type {
  Automation,
  AutomationAction,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
  BulkAction,
  BulkResult,
  BulkSelection,
  Contact,
  CustomField,
  CustomFieldType,
  Segment,
  SegmentFilter,
} from '@scalo/shared';
import { request } from './api';
import type { ContactFilter } from './api';

type Ok = { ok: true };
const qs = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export interface ContactQuery {
  search?: string;
  tag_id?: number | null;
  status?: ContactFilter | null;
  segment_id?: number | null;
  filter?: SegmentFilter | null;
  page?: number;
  limit?: number;
}

export interface AutomationInput {
  name: string;
  enabled?: boolean;
  trigger: AutomationTrigger;
  conditions?: SegmentFilter | null;
  actions: AutomationAction[];
  run_once?: boolean;
}

export const crmApi = {
  // custom fields
  customFields: () => request<CustomField[]>('GET', '/custom-fields'),
  createCustomField: (b: { key?: string; label: string; type: CustomFieldType; options?: string[] }) => request<CustomField>('POST', '/custom-fields', b),
  updateCustomField: (id: number, b: { label?: string; options?: string[] }) => request<CustomField>('PATCH', `/custom-fields/${id}`, b),
  reorderCustomFields: (ids: number[]) => request<CustomField[]>('POST', '/custom-fields/reorder', { ids }),
  deleteCustomField: (id: number) => request<Ok>('DELETE', `/custom-fields/${id}`),

  // segments
  segments: (counts = true) => request<Segment[]>('GET', `/segments${counts ? '' : '?counts=0'}`),
  segment: (id: number) => request<Segment>('GET', `/segments/${id}`),
  createSegment: (b: { name: string; filter: SegmentFilter }) => request<Segment>('POST', '/segments', b),
  updateSegment: (id: number, b: { name?: string; filter?: SegmentFilter }) => request<Segment>('PATCH', `/segments/${id}`, b),
  deleteSegment: (id: number) => request<Ok>('DELETE', `/segments/${id}`),
  previewSegment: (filter: SegmentFilter) => request<{ count: number }>('POST', '/segments/preview', { filter }),

  // contacts
  queryContacts: (q: ContactQuery) => request<{ items: Contact[]; total: number }>('POST', '/contacts/query', q),
  bulk: (selection: BulkSelection, action: BulkAction) => request<BulkResult>('POST', '/contacts/bulk', { selection, action }),

  // automations
  automations: () => request<Automation[]>('GET', '/automations'),
  automation: (id: number) => request<Automation>('GET', `/automations/${id}`),
  createAutomation: (b: AutomationInput) => request<Automation>('POST', '/automations', b),
  updateAutomation: (id: number, b: Partial<AutomationInput>) => request<Automation>('PATCH', `/automations/${id}`, b),
  deleteAutomation: (id: number) => request<Ok>('DELETE', `/automations/${id}`),
  rotateAutomationSecret: (id: number, which: 'webhook' | 'signing') => request<Automation>('POST', `/automations/${id}/rotate-secret`, { which }),
  automationRuns: (id: number | null, p: { page?: number; limit?: number; status?: AutomationRunStatus | '' } = {}) =>
    request<{ items: AutomationRun[]; total: number }>('GET', `${id ? `/automations/${id}/runs` : '/automations/runs'}${qs(p)}`),
};

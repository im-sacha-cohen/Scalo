// Migration from another tool: contact imports (systeme.io API, CSV exports) and page import by URL.
// See SPEC.md « Migrer depuis un autre outil ».
import type { ImportAnalysis, ImportColumnMapping, ImportJob, ImportOptions, ImportPreview, PageImportResult } from '@scalo/shared';
import { rawRequest, request } from './api';

/** Where the contacts come from. The API key / the file stay in memory in the browser until the import is queued. */
export type ImportSourceInput = { source: 'csv'; csv: string; file_name?: string } | { source: 'systeme_io'; api_key: string };

export type SystemeIoAnalysis = ImportAnalysis & { tags: string[]; has_more: boolean };

export const importApi = {
  analyzeCsv: (csv: string) => request<ImportAnalysis>('POST', '/imports/csv/analyze', { csv }),
  connectSystemeIo: (api_key: string) => request<SystemeIoAnalysis>('POST', '/imports/systeme-io/connect', { api_key }),
  preview: (src: ImportSourceInput, mapping: ImportColumnMapping[]) => request<ImportPreview>('POST', '/imports/preview', { ...src, mapping }),
  start: (src: ImportSourceInput, mapping: ImportColumnMapping[], options: ImportOptions) => request<ImportJob>('POST', '/imports', { ...src, mapping, options }),
  list: () => request<ImportJob[]>('GET', '/imports'),
  get: (id: number) => request<ImportJob>('GET', `/imports/${id}`),
  cancel: (id: number) => request<ImportJob>('POST', `/imports/${id}/cancel`),
  errorsCsv: async (id: number) => (await rawRequest('GET', `/imports/${id}/errors.csv`)).blob(),
  importPage: (url: string, consent: boolean) => request<PageImportResult>('POST', '/imports/page', { url, consent }),
};

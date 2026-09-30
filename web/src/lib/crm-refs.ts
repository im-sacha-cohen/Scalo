// Reference data used by the filter builder and the automation editor (tags, custom fields, funnels, campaigns…).
import { useCallback, useEffect, useState } from 'react';
import type { Broadcast, Campaign, CustomField, Funnel, Segment, Tag } from '@scalo/shared';
import { api } from './api';
import { crmApi } from './crm-api';

export interface CrmRefs {
  tags: Tag[];
  fields: CustomField[];
  funnels: Funnel[];
  campaigns: Campaign[];
  segments: Segment[];
  broadcasts: Broadcast[];
  loaded: boolean;
}

const EMPTY: CrmRefs = { tags: [], fields: [], funnels: [], campaigns: [], segments: [], broadcasts: [], loaded: false };

// custom fields for the merge tag menu of the editors: fetched once per minute at most
let fieldsCache: { at: number; p: Promise<CustomField[]> } | null = null;
function cachedFields() {
  if (!fieldsCache || Date.now() - fieldsCache.at > 60_000) fieldsCache = { at: Date.now(), p: crmApi.customFields().catch(() => []) };
  return fieldsCache.p;
}

/** Builtin merge tags + `{{field.key}}` of every custom field. */
export function useMergeTags(base: { tag: string; label: string }[]) {
  const [fields, setFields] = useState<CustomField[]>([]);
  useEffect(() => {
    let alive = true;
    void cachedFields().then((f) => alive && setFields(f));
    return () => {
      alive = false;
    };
  }, []);
  return [...base, ...fields.map((f) => ({ tag: `{{field.${f.key}}}`, label: f.label }))];
}

/** Loads the reference lists once; `reload()` refreshes them (e.g. after creating a tag). */
export function useCrmRefs(opts: { broadcasts?: boolean } = {}) {
  const [refs, setRefs] = useState<CrmRefs>(EMPTY);
  const withBroadcasts = !!opts.broadcasts;
  const reload = useCallback(async () => {
    const [tags, fields, funnels, campaigns, segments, broadcasts] = await Promise.all([
      api.tags().catch(() => [] as Tag[]),
      crmApi.customFields().catch(() => [] as CustomField[]),
      api.funnels().catch(() => [] as Funnel[]),
      api.campaigns().catch(() => [] as Campaign[]),
      crmApi.segments(false).catch(() => [] as Segment[]),
      withBroadcasts ? api.broadcasts().catch(() => [] as Broadcast[]) : Promise.resolve([] as Broadcast[]),
    ]);
    setRefs({ tags, fields, funnels, campaigns, segments, broadcasts, loaded: true });
  }, [withBroadcasts]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { refs, reload };
}

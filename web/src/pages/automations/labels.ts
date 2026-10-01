import {
  AUTOMATION_ACTION_LABELS,
  AUTOMATION_TRIGGER_LABELS,
  type AutomationAction,
  type AutomationRunStatus,
  type AutomationTrigger,
} from '@scalo/shared';
import type { CrmRefs } from '../../lib/crm-refs';
import { fmtFieldDateTime } from '../../lib/format';

const name = <T extends { id: number }>(list: T[], id: number | null | undefined, get: (x: T) => string, fallback: string) =>
  id ? (list.find((x) => x.id === id) ? get(list.find((x) => x.id === id)!) : `${fallback} #${id}`) : null;

export function describeTrigger(t: AutomationTrigger, refs: CrmRefs): string {
  const base = AUTOMATION_TRIGGER_LABELS[t.type];
  switch (t.type) {
    case 'tag_added':
    case 'tag_removed':
      return `${base} « ${name(refs.tags, t.tag_id, (x) => x.name, 'tag') ?? '?'} »`;
    case 'optin': {
      const f = name(refs.funnels, t.funnel_id, (x) => x.name, 'tunnel');
      return f ? `${base} du tunnel « ${f} »${t.step_id ? ' (une étape)' : ''}` : `${base} (tous les tunnels)`;
    }
    case 'link_clicked': {
      const parts = [
        t.url_contains ? `URL contenant « ${t.url_contains} »` : null,
        t.broadcast_id ? `newsletter « ${name(refs.broadcasts, t.broadcast_id, (x) => x.subject, 'newsletter')} »` : null,
        t.campaign_id ? `campagne « ${name(refs.campaigns, t.campaign_id, (x) => x.name, 'campagne')} »` : null,
      ].filter(Boolean);
      return parts.length ? `${base} : ${parts.join(', ')}` : base;
    }
    case 'purchase':
      return t.product ? `${base} de « ${t.product} »` : `${base} (tous les produits)`;
    case 'campaign_completed': {
      const c = name(refs.campaigns, t.campaign_id, (x) => x.name, 'campagne');
      return c ? `${base} « ${c} »` : `${base} (toutes)`;
    }
    default:
      return base;
  }
}

const UNITS = { minutes: 'minute(s)', hours: 'heure(s)', days: 'jour(s)' };

export function describeAction(a: AutomationAction, refs: CrmRefs): string {
  const base = AUTOMATION_ACTION_LABELS[a.type];
  switch (a.type) {
    case 'add_tag':
    case 'remove_tag':
      return `${base} « ${name(refs.tags, a.tag_id, (x) => x.name, 'tag') ?? '?'} »`;
    case 'enroll':
    case 'unenroll':
      return `${base} « ${name(refs.campaigns, a.campaign_id, (x) => x.name, 'campagne') ?? '?'} »`;
    case 'set_field': {
      const f = refs.fields.find((x) => x.key === a.key);
      const shown = f?.type === 'datetime' && typeof a.value === 'string' && a.value ? fmtFieldDateTime(a.value) : a.value;
      return `${f?.label ?? a.key} = ${a.value === null || a.value === '' ? '(vide)' : typeof a.value === 'boolean' ? (a.value ? 'oui' : 'non') : shown}`;
    }
    case 'webhook':
      try {
        return `${base} ${new URL(a.url).host}`;
      } catch {
        return base;
      }
    case 'wait':
      return `Attendre ${a.amount} ${UNITS[a.unit]}`;
    default:
      return base;
  }
}

export const RUN_STATUS: Record<AutomationRunStatus, { label: string; tone: 'slate' | 'brand' | 'green' | 'amber' | 'red' | 'blue' | 'violet' }> = {
  pending: { label: 'En file', tone: 'blue' },
  running: { label: 'En cours', tone: 'brand' },
  waiting: { label: 'En attente', tone: 'amber' },
  completed: { label: 'Terminée', tone: 'green' },
  failed: { label: 'Échec', tone: 'red' },
  skipped: { label: 'Ignorée', tone: 'slate' },
};

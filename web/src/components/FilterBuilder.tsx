// Multi-criteria filter editor (segments, contact list, automation conditions): conditions combined with ET / OU,
// plus one level of groups.
import type { ReactNode } from 'react';
import { Plus, X, Layers } from 'lucide-react';
import {
  BUILTIN_FIELDS,
  isFilterGroup,
  type CustomField,
  type FieldOperator,
  type SegmentCondition,
  type SegmentConditionType,
  type SegmentFilter,
} from '@scalo/shared';
import type { CrmRefs } from '../lib/crm-refs';
import { isoToLocalInput, localInputToIso } from '../lib/format';
import { Button, cx, Input, Select } from './ui';

const TYPE_LABELS: Record<SegmentConditionType, string> = {
  tag: 'Tag',
  field: 'Champ',
  status: 'Statut',
  created: 'Date d’ajout',
  email_activity: 'Activité email',
  optin: 'Inscription via un tunnel',
  campaign: 'Campagne',
  purchase: 'Achat',
};

const BUILTIN_LABELS: Record<string, string> = { email: 'Email', first_name: 'Prénom', last_name: 'Nom', phone: 'Téléphone' };

const OP_LABELS: Record<FieldOperator, string> = {
  eq: 'est égal à',
  neq: 'est différent de',
  contains: 'contient',
  not_contains: 'ne contient pas',
  gt: 'est supérieur à',
  lt: 'est inférieur à',
  within_days: 'dans les derniers',
  empty: 'est vide',
  not_empty: 'n’est pas vide',
};

const isDateType = (t: CustomField['type'] | 'text') => t === 'date' || t === 'datetime';

function fieldOps(type: CustomField['type'] | 'text'): FieldOperator[] {
  if (type === 'number') return ['eq', 'neq', 'gt', 'lt', 'empty', 'not_empty'];
  if (type === 'date') return ['eq', 'gt', 'lt', 'within_days', 'empty', 'not_empty'];
  if (type === 'datetime') return ['gt', 'lt', 'within_days', 'empty', 'not_empty'];
  if (type === 'checkbox') return ['eq'];
  if (type === 'select') return ['eq', 'neq', 'empty', 'not_empty'];
  return ['eq', 'neq', 'contains', 'not_contains', 'empty', 'not_empty'];
}

export function defaultCondition(type: SegmentConditionType, refs: CrmRefs): SegmentCondition {
  switch (type) {
    case 'tag':
      return { type, op: 'has', tag_id: refs.tags[0]?.id ?? 0 };
    case 'field': {
      const f = refs.fields[0];
      return f ? { type, key: f.key, op: f.type === 'checkbox' ? 'eq' : f.type === 'number' || f.type === 'datetime' ? 'gt' : 'eq', value: f.type === 'checkbox' ? true : '' } : { type, key: 'email', op: 'contains', value: '' };
    }
    case 'status':
      return { type, op: 'is', value: 'confirmed' };
    case 'created':
      return { type, op: 'within_days', value: 30 };
    case 'email_activity':
      return { type, op: 'opened', days: 30 };
    case 'optin':
      return { type, op: 'did', funnel_id: null };
    case 'campaign':
      return { type, op: 'enrolled', campaign_id: refs.campaigns[0]?.id ?? 0 };
    case 'purchase':
      return { type, op: 'did', product: '' };
  }
}

/** True when every condition has its required value (the API would reject an incomplete filter). */
export function isFilterComplete(f: SegmentFilter): boolean {
  return f.conditions.every((c) => {
    if (isFilterGroup(c)) return isFilterComplete(c);
    switch (c.type) {
      case 'tag':
        return c.tag_id > 0;
      case 'campaign':
        return c.campaign_id > 0;
      case 'field':
        return c.op === 'empty' || c.op === 'not_empty' || (c.value !== undefined && c.value !== null && c.value !== '');
      case 'created':
        return c.value !== '' && c.value !== undefined;
      default:
        return true;
    }
  });
}

export const countConditions = (f: SegmentFilter): number => f.conditions.reduce((n, c) => n + (isFilterGroup(c) ? countConditions(c) : 1), 0);

const small = 'h-8 text-[13px]';

function ConditionRow({ c, onChange, refs }: { c: SegmentCondition; onChange: (c: SegmentCondition) => void; refs: CrmRefs }) {
  const typeSelect = (
    <Select className="w-44 shrink-0" value={c.type} onChange={(e) => onChange(defaultCondition(e.target.value as SegmentConditionType, refs))} aria-label="Critère">
      {(Object.keys(TYPE_LABELS) as SegmentConditionType[]).map((t) => (
        <option key={t} value={t}>
          {TYPE_LABELS[t]}
        </option>
      ))}
    </Select>
  );
  let rest: ReactNode = null;
  switch (c.type) {
    case 'tag':
      rest = (
        <>
          <Select className="w-40" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'has' })}>
            <option value="has">a le tag</option>
            <option value="not_has">n’a pas le tag</option>
          </Select>
          <Select className="min-w-40 flex-1" value={c.tag_id || ''} onChange={(e) => onChange({ ...c, tag_id: Number(e.target.value) })}>
            <option value="">Choisir un tag…</option>
            {refs.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </>
      );
      break;
    case 'field': {
      const def = refs.fields.find((f) => f.key === c.key);
      const ftype = def?.type ?? 'text';
      const ops = fieldOps(ftype);
      const needsValue = c.op !== 'empty' && c.op !== 'not_empty';
      rest = (
        <>
          <Select
            className="w-44"
            value={c.key}
            onChange={(e) => {
              const d = refs.fields.find((f) => f.key === e.target.value);
              const t = d?.type ?? 'text';
              const op = fieldOps(t).includes(c.op) ? c.op : fieldOps(t)[0];
              onChange({ ...c, key: e.target.value, op, value: t === 'checkbox' ? true : op === 'within_days' ? 7 : '' });
            }}
          >
            <optgroup label="Contact">
              {BUILTIN_FIELDS.map((k) => (
                <option key={k} value={k}>
                  {BUILTIN_LABELS[k]}
                </option>
              ))}
            </optgroup>
            {refs.fields.length > 0 && (
              <optgroup label="Champs personnalisés">
                {refs.fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          {ftype === 'checkbox' ? (
            <Select className="w-36" value={c.value === false || c.value === 'false' ? 'false' : 'true'} onChange={(e) => onChange({ ...c, op: 'eq', value: e.target.value === 'true' })}>
              <option value="true">est coché</option>
              <option value="false">n’est pas coché</option>
            </Select>
          ) : (
            <>
              <Select
                className="w-40"
                value={c.op}
                onChange={(e) => {
                  const op = e.target.value as FieldOperator;
                  // « dans les N derniers jours » takes a number of days, the other operators a date
                  const value = (op === 'within_days') === (c.op === 'within_days') ? c.value : op === 'within_days' ? 7 : '';
                  onChange({ ...c, op, value });
                }}
              >
                {ops.map((o) => (
                  <option key={o} value={o}>
                    {isDateType(ftype) && o === 'gt' ? 'est après le' : isDateType(ftype) && o === 'lt' ? 'est avant le' : OP_LABELS[o]}
                  </option>
                ))}
              </Select>
              {needsValue &&
                (c.op === 'within_days' ? (
                  <span className="flex items-center gap-2 text-sm text-slate-600">
                    <Input className={cx('w-20', small)} type="number" min={0} value={String(c.value ?? '')} aria-label="Nombre de jours" onChange={(e) => onChange({ ...c, value: e.target.value === '' ? '' : Math.max(0, Math.trunc(Number(e.target.value))) })} />
                    jours
                  </span>
                ) : ftype === 'datetime' ? (
                  <Input
                    className={cx('min-w-44 flex-1', small)}
                    type="datetime-local"
                    aria-label="Date et heure"
                    value={isoToLocalInput(typeof c.value === 'string' ? c.value : '')}
                    onChange={(e) => onChange({ ...c, value: localInputToIso(e.target.value) })}
                  />
                ) : ftype === 'select' ? (
                  <Select className="min-w-32 flex-1" value={String(c.value ?? '')} onChange={(e) => onChange({ ...c, value: e.target.value })}>
                    <option value="">Choisir…</option>
                    {def!.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    className={cx('min-w-32 flex-1', small)}
                    type={ftype === 'number' ? 'number' : ftype === 'date' ? 'date' : 'text'}
                    value={String(c.value ?? '')}
                    placeholder="Valeur"
                    onChange={(e) => onChange({ ...c, value: ftype === 'number' && e.target.value !== '' ? Number(e.target.value) : e.target.value })}
                  />
                ))}
            </>
          )}
        </>
      );
      break;
    }
    case 'status':
      rest = (
        <>
          <Select className="w-32" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'is' })}>
            <option value="is">est</option>
            <option value="is_not">n’est pas</option>
          </Select>
          <Select className="min-w-44 flex-1" value={c.value} onChange={(e) => onChange({ ...c, value: e.target.value as 'confirmed' })}>
            <option value="confirmed">Abonné (confirmé)</option>
            <option value="pending_confirmation">En attente de confirmation</option>
            <option value="unsubscribed">Désinscrit</option>
            <option value="bounced">Adresse invalide (bounce)</option>
          </Select>
        </>
      );
      break;
    case 'created': {
      const byDays = c.op === 'within_days' || c.op === 'older_than_days';
      rest = (
        <>
          <Select
            className="w-52"
            value={c.op}
            onChange={(e) => {
              const op = e.target.value as typeof c.op;
              const days = op === 'within_days' || op === 'older_than_days';
              onChange({ ...c, op, value: days === byDays ? c.value : days ? 30 : new Date().toISOString().slice(0, 10) });
            }}
          >
            <option value="within_days">depuis moins de</option>
            <option value="older_than_days">il y a plus de</option>
            <option value="before">avant le</option>
            <option value="after">après le</option>
          </Select>
          {byDays ? (
            <div className="flex items-center gap-2">
              <Input className={cx('w-24', small)} type="number" min={0} value={String(c.value)} onChange={(e) => onChange({ ...c, value: Number(e.target.value) })} />
              <span className="text-sm text-slate-500">jours</span>
            </div>
          ) : (
            <Input className={cx('w-44', small)} type="date" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })} />
          )}
        </>
      );
      break;
    }
    case 'email_activity':
      rest = (
        <>
          <Select className="w-52" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'opened' })}>
            <option value="opened">a ouvert un email</option>
            <option value="clicked">a cliqué dans un email</option>
            <option value="not_opened">n’a ouvert aucun email</option>
            <option value="not_clicked">n’a cliqué dans aucun email</option>
          </Select>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-500">ces</span>
            <Input className={cx('w-20', small)} type="number" min={1} value={String(c.days)} onChange={(e) => onChange({ ...c, days: Math.max(1, Number(e.target.value) || 1) })} />
            <span className="text-sm text-slate-500">derniers jours</span>
          </div>
        </>
      );
      break;
    case 'optin':
      rest = (
        <>
          <Select className="w-44" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'did' })}>
            <option value="did">s’est inscrit via</option>
            <option value="did_not">ne s’est pas inscrit via</option>
          </Select>
          <Select className="min-w-40 flex-1" value={c.funnel_id ?? ''} onChange={(e) => onChange({ ...c, funnel_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">n’importe quel tunnel</option>
            {refs.funnels.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </Select>
        </>
      );
      break;
    case 'campaign':
      rest = (
        <>
          <Select className="w-52" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'enrolled' })}>
            <option value="enrolled">est inscrit à</option>
            <option value="completed">a terminé</option>
            <option value="not_enrolled">n’est pas inscrit à</option>
          </Select>
          <Select className="min-w-40 flex-1" value={c.campaign_id || ''} onChange={(e) => onChange({ ...c, campaign_id: Number(e.target.value) })}>
            <option value="">Choisir une campagne…</option>
            {refs.campaigns.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </>
      );
      break;
    case 'purchase':
      rest = (
        <>
          <Select className="w-44" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value as 'did' })}>
            <option value="did">a acheté</option>
            <option value="did_not">n’a pas acheté</option>
          </Select>
          <Input className={cx('min-w-40 flex-1', small)} value={c.product ?? ''} placeholder="n’importe quel produit" onChange={(e) => onChange({ ...c, product: e.target.value })} />
        </>
      );
      break;
  }
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      {typeSelect}
      {rest}
    </div>
  );
}

function MatchSelect({ value, onChange, nested }: { value: 'all' | 'any'; onChange: (v: 'all' | 'any') => void; nested?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
      <span>{nested ? 'Groupe :' : 'Contacts correspondant à'}</span>
      <Select className="w-44" value={value} onChange={(e) => onChange(e.target.value as 'all' | 'any')}>
        <option value="all">toutes les conditions (ET)</option>
        <option value="any">au moins une condition (OU)</option>
      </Select>
      {!nested && <span>suivantes :</span>}
    </div>
  );
}

function Group({ filter, onChange, refs, nested, onRemove }: { filter: SegmentFilter; onChange: (f: SegmentFilter) => void; refs: CrmRefs; nested?: boolean; onRemove?: () => void }) {
  const set = (i: number, c: SegmentCondition | SegmentFilter) => onChange({ ...filter, conditions: filter.conditions.map((x, k) => (k === i ? c : x)) });
  const remove = (i: number) => onChange({ ...filter, conditions: filter.conditions.filter((_, k) => k !== i) });
  const joiner = filter.match === 'all' ? 'ET' : 'OU';
  return (
    <div className={cx('space-y-2.5', nested && 'rounded-lg border border-dashed border-slate-300 bg-slate-50/60 p-3')}>
      <div className="flex items-center justify-between gap-2">
        <MatchSelect value={filter.match} onChange={(match) => onChange({ ...filter, match })} nested={nested} />
        {onRemove && (
          <button type="button" onClick={onRemove} className="rounded-md p-1 text-slate-400 hover:bg-slate-200/60 hover:text-slate-700" title="Supprimer le groupe">
            <X size={15} />
          </button>
        )}
      </div>
      {filter.conditions.map((c, i) => (
        <div key={i}>
          {i > 0 && <div className="mb-2 pl-1 text-[11px] font-semibold tracking-wide text-slate-400">{joiner}</div>}
          {isFilterGroup(c) ? (
            <Group filter={c} onChange={(g) => set(i, g)} refs={refs} nested onRemove={() => remove(i)} />
          ) : (
            <div className="flex items-start gap-2">
              <ConditionRow c={c} onChange={(x) => set(i, x)} refs={refs} />
              <button type="button" onClick={() => remove(i)} className="mt-1 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600" title="Retirer la condition">
                <X size={15} />
              </button>
            </div>
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="secondary" icon={Plus} onClick={() => onChange({ ...filter, conditions: [...filter.conditions, defaultCondition(refs.tags.length ? 'tag' : 'status', refs)] })}>
          Condition
        </Button>
        {!nested && (
          <Button
            size="xs"
            variant="ghost"
            icon={Layers}
            onClick={() => onChange({ ...filter, conditions: [...filter.conditions, { match: filter.match === 'all' ? 'any' : 'all', conditions: [defaultCondition('status', refs)] }] })}
          >
            Groupe {filter.match === 'all' ? '(OU)' : '(ET)'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Editor of a SegmentFilter. `refs`: tags, fields, funnels, campaigns of the account (useCrmRefs). */
export function FilterBuilder({ value, onChange, refs }: { value: SegmentFilter; onChange: (f: SegmentFilter) => void; refs: CrmRefs }) {
  return <Group filter={value} onChange={onChange} refs={refs} />;
}

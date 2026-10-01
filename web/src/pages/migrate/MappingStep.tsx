// Import assistant, step « Correspondance » : for each source column (with a few values), a standard field, an existing
// custom field, a new custom field (name, type proposed from the values, list options from the distinct values) or
// « Ignorer ». Values that the chosen field would reject are counted (they are ignored at import and journaled).
import { useMemo } from 'react';
import { CircleAlert, CircleCheck, Plus, Sparkles } from 'lucide-react';
import {
  CUSTOM_FIELD_TYPE_LABELS,
  CUSTOM_FIELD_TYPES,
  IMPORT_TARGET_LABELS,
  type CustomField,
  type CustomFieldType,
  type ImportAnalysis,
  type ImportColumn,
  type ImportColumnMapping,
  type ImportTarget,
} from '@scalo/shared';
import { fmtNumber } from '../../lib/format';
import { Badge, cx, Input, Select, Textarea } from '../../components/ui';

/** Standard fields, in the order of the menu. The first five can be fed by one column only. */
const STANDARD: ImportTarget[] = ['email', 'first_name', 'last_name', 'phone', 'created_at', 'status', 'tags', 'unsubscribed', 'bounced'];
/** Targets that can be fed by one column only (same rule as the API). */
export const SINGLE_TARGETS: ImportTarget[] = ['email', 'first_name', 'last_name', 'phone', 'created_at', 'status'];
const STANDARD_LABELS: Partial<Record<ImportTarget, string>> = { created_at: 'Date d’inscription', status: 'Statut d’abonnement' };

/** « 1 valeur n’est pas… » / « 3 valeurs ne sont pas… ». */
const TYPE_ERRORS: Partial<Record<CustomFieldType, [string, string]>> = {
  number: ['n’est pas un nombre', 'ne sont pas des nombres'],
  date: ['n’est pas une date (AAAA-MM-JJ ou JJ/MM/AAAA)', 'ne sont pas des dates (AAAA-MM-JJ ou JJ/MM/AAAA)'],
  datetime: ['n’est pas une date et heure (ISO 8601 ou JJ/MM/AAAA HH:mm)', 'ne sont pas des dates et heures (ISO 8601 ou JJ/MM/AAAA HH:mm)'],
  checkbox: ['n’est pas un oui / non', 'ne sont pas des oui / non'],
};

const plural = (n: number, one: string, many: string) => `${fmtNumber(n)} ${n > 1 ? many : one}`;
const parseOptions = (s: string) => [...new Map(s.split('\n').map((o) => o.trim()).filter(Boolean).map((o) => [o.toLowerCase(), o.slice(0, 100)])).values()].slice(0, 100);

/** Values of the column that a field of this type (and options) would reject; null when it cannot be known here. */
export function columnIssue(c: ImportColumn, type: CustomFieldType, options: string[]): { count: number; examples: string[]; distinctOnly?: boolean } | null {
  const st = c.stats;
  if (!st || type === 'text') return null;
  if (type === 'select') {
    if (st.distinct_more) return null; // checked during the import (journal)
    const opts = new Set(options.map((o) => o.toLowerCase()));
    const bad = st.distinct.filter((v) => !opts.has(v.toLowerCase()));
    return bad.length ? { count: bad.length, examples: bad.slice(0, 3), distinctOnly: true } : null;
  }
  const inv = st.invalid[type];
  return inv && inv.count ? { count: inv.count, examples: inv.examples } : null;
}

/** What prevents going on with this mapping (null = nothing). */
export function mappingProblem(mapping: ImportColumnMapping[]): string | null {
  if (!mapping.some((m) => m.target === 'email')) return 'Indiquez la colonne qui contient l’adresse email.';
  for (const t of SINGLE_TARGETS) if (mapping.filter((m) => m.target === t).length > 1) return 'Une même information ne peut venir que d’une seule colonne.';
  for (const m of mapping) {
    if (m.target !== 'field' || m.field_key || !m.create) continue;
    if (!m.create.label.trim()) return `Donnez un nom au nouveau champ de la colonne « ${m.column} ».`;
    if (m.create.type === 'select' && !m.create.options?.length) return `Ajoutez au moins une option à la liste « ${m.create.label} ».`;
  }
  const keys = mapping.filter((m) => m.target === 'field').map((m) => m.field_key ?? `new:${m.create?.label.trim().toLowerCase()}`);
  if (new Set(keys).size !== keys.length) return 'Deux colonnes ne peuvent pas alimenter le même champ personnalisé.';
  return null;
}

const valueOf = (m: ImportColumnMapping | undefined) => (!m ? 'ignore' : m.target !== 'field' ? m.target : m.field_key ? `field:${m.field_key}` : 'create');

export function MappingStep({
  analysis,
  mapping,
  onChange,
  fields,
}: {
  analysis: ImportAnalysis;
  mapping: ImportColumnMapping[];
  onChange: (m: ImportColumnMapping[]) => void;
  fields: CustomField[];
}) {
  const byColumn = useMemo(() => new Map(mapping.map((m) => [m.column, m])), [mapping]);
  const set = (column: string, next: ImportColumnMapping) => onChange(mapping.map((m) => (m.column === column ? next : m)));
  // which column already feeds a single-column target / an existing custom field
  const usedBy = useMemo(() => {
    const out = new Map<string, string>();
    for (const m of mapping) {
      const v = valueOf(m);
      if (v !== 'ignore' && v !== 'create' && v !== 'tags' && v !== 'unsubscribed' && v !== 'bounced') out.set(v, m.column);
    }
    return out;
  }, [mapping]);

  const choose = (c: ImportColumn, v: string) => {
    if (v === 'create') {
      const type = c.stats?.suggested_type ?? 'text';
      set(c.column, { column: c.column, target: 'field', create: { label: c.label.slice(0, 80), type, ...(type === 'select' ? { options: c.stats?.distinct ?? [] } : {}) } });
    } else if (v.startsWith('field:')) set(c.column, { column: c.column, target: 'field', field_key: v.slice(6) });
    else set(c.column, { column: c.column, target: v as ImportTarget });
  };

  const mapped = mapping.filter((m) => m.target !== 'ignore').length;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        {plural(analysis.columns.length, 'colonne', 'colonnes')} · {plural(mapped, 'importée', 'importées')}. Chaque colonne devient un champ standard, un champ personnalisé (existant ou à créer) ou est ignorée.
      </p>
      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
        {analysis.columns.map((c) => {
          const m = byColumn.get(c.column);
          const v = valueOf(m);
          const def = m?.field_key ? fields.find((f) => f.key === m.field_key) : undefined;
          const create = m?.target === 'field' && !m.field_key ? m.create : undefined;
          const ftype = create?.type ?? def?.type;
          const issue = create ? columnIssue(c, create.type, create.options ?? []) : def ? columnIssue(c, def.type, def.options) : null;
          const checkable = !!ftype && ftype !== 'text' && !!c.stats && c.stats.filled > 0 && !(ftype === 'select' && c.stats.distinct_more);
          const ignored = v === 'ignore';
          const filled = c.stats?.filled;
          return (
            <li key={c.column} className={cx('grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-start', ignored && 'bg-slate-50/60')}>
              <div className="min-w-0">
                <p className={cx('truncate text-sm font-semibold', ignored ? 'text-slate-500' : 'text-ink')} title={c.label}>
                  {c.label}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500" title={c.samples.join(' · ')}>
                  {c.samples.length ? c.samples.slice(0, 3).map((s) => `« ${s} »`).join(' · ') : 'Colonne vide'}
                </p>
                {filled !== undefined && analysis.rows !== null && filled < analysis.rows && filled > 0 && (
                  <p className="mt-0.5 text-[11px] text-slate-400">{plural(filled, 'valeur renseignée', 'valeurs renseignées')} sur {fmtNumber(analysis.rows)}</p>
                )}
              </div>
              <div className="min-w-0 space-y-2">
                <Select value={v} onChange={(e) => choose(c, e.target.value)} aria-label={`Destination de la colonne ${c.label}`} className={cx(ignored && 'text-slate-500')}>
                  <option value="ignore">Ignorer cette colonne</option>
                  <optgroup label="Champs standard">
                    {STANDARD.map((t) => {
                      const other = usedBy.get(t);
                      const taken = !!other && other !== c.column && SINGLE_TARGETS.includes(t);
                      return (
                        <option key={t} value={t} disabled={taken}>
                          {STANDARD_LABELS[t] ?? IMPORT_TARGET_LABELS[t]}
                          {t === 'email' ? ' (obligatoire)' : ''}
                          {taken ? ` — déjà : ${other.slice(0, 30)}` : ''}
                        </option>
                      );
                    })}
                  </optgroup>
                  {fields.length > 0 && (
                    <optgroup label="Champs personnalisés">
                      {fields.map((f) => {
                        const other = usedBy.get(`field:${f.key}`);
                        const taken = !!other && other !== c.column;
                        return (
                          <option key={f.key} value={`field:${f.key}`} disabled={taken}>
                            {f.label} · {CUSTOM_FIELD_TYPE_LABELS[f.type]}
                            {taken ? ` — déjà : ${other.slice(0, 30)}` : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                  <optgroup label="Nouveau">
                    <option value="create">Créer un champ personnalisé…</option>
                  </optgroup>
                </Select>

                {create && m && (
                  <div className="space-y-2 rounded-lg border border-brand-100 bg-brand-50/40 p-3">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-brand-800">
                      <span className="inline-flex items-center gap-1 whitespace-nowrap">
                        <Plus size={13} /> Nouveau champ personnalisé
                      </span>
                      <Badge tone="amber">créé au lancement de l’import</Badge>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-600">Nom du champ</span>
                        <Input value={create.label} maxLength={80} onChange={(e) => set(c.column, { ...m, create: { ...create, label: e.target.value } })} aria-label="Nom du nouveau champ" />
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-600">Type</span>
                        <Select
                          value={create.type}
                          aria-label="Type du nouveau champ"
                          onChange={(e) => {
                            const type = e.target.value as CustomFieldType;
                            set(c.column, { ...m, create: { label: create.label, type, ...(type === 'select' ? { options: create.options?.length ? create.options : c.stats?.distinct ?? [] } : {}) } });
                          }}
                        >
                          {CUSTOM_FIELD_TYPES.map((t) => (
                            <option key={t} value={t}>
                              {CUSTOM_FIELD_TYPE_LABELS[t]}
                              {c.stats?.suggested_type === t ? ' (proposé)' : ''}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </div>
                    {c.stats && c.stats.suggested_type === create.type && create.type !== 'text' && (
                      <p className="flex items-center gap-1.5 text-xs text-brand-700">
                        <Sparkles size={13} /> Type proposé d’après les valeurs de la colonne.
                      </p>
                    )}
                    {create.type === 'datetime' && <p className="text-xs text-slate-500">Une heure sans fuseau (ex. 01/10/2026 14:30) est lue à l’heure de Paris ; la valeur est enregistrée en UTC.</p>}
                    {create.type === 'select' && (
                      <label className="block">
                        <span className="mb-1 block text-xs font-medium text-slate-600">
                          Options de la liste {c.stats?.distinct_more ? '(100 premières valeurs distinctes)' : '(valeurs distinctes de la colonne)'}
                        </span>
                        <Textarea
                          rows={Math.min(6, Math.max(2, create.options?.length ?? 2))}
                          value={(create.options ?? []).join('\n')}
                          onChange={(e) => set(c.column, { ...m, create: { ...create, options: parseOptions(e.target.value) } })}
                          aria-label="Options de la liste, une par ligne"
                        />
                        <span className="mt-1 block text-xs text-slate-500">Une option par ligne.</span>
                      </label>
                    )}
                  </div>
                )}

                {issue ? (
                  <p className="flex items-start gap-1.5 text-xs text-amber-800" role="status">
                    <CircleAlert size={14} className="mt-px shrink-0 text-amber-600" />
                    <span>
                      {issue.distinctOnly
                        ? `${plural(issue.count, 'valeur distincte absente', 'valeurs distinctes absentes')} de la liste`
                        : `${plural(issue.count, 'valeur', 'valeurs')} ${TYPE_ERRORS[ftype as CustomFieldType]?.[issue.count > 1 ? 1 : 0] ?? 'invalide'}`}{' '}
                      (ex. {issue.examples.map((x) => `« ${x} »`).join(', ')}) : {issue.count > 1 ? 'elles seront ignorées' : 'elle sera ignorée'} et listée{issue.count > 1 ? 's' : ''} dans le journal de l’import.
                    </span>
                  </p>
                ) : checkable ? (
                  <p className="flex items-center gap-1.5 text-xs text-emerald-700">
                    <CircleCheck size={14} /> Toutes les valeurs sont valides.
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

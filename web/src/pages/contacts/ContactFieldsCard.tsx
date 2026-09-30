// Contact page: custom field values (edited in place, saved together).
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Braces } from 'lucide-react';
import type { Contact, CustomField } from '@scalo/shared';
import { api } from '../../lib/api';
import { crmApi } from '../../lib/crm-api';
import { useLoad } from '../../lib/hooks';
import { Button, Card, CardHeader, Field, Input, Select, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';

type Values = Record<string, string | boolean>;

const toForm = (defs: CustomField[], fields: Contact['fields']): Values =>
  Object.fromEntries(defs.map((d) => [d.key, d.type === 'checkbox' ? fields?.[d.key] === true : fields?.[d.key] === undefined ? '' : String(fields[d.key])]));

export function ContactFieldsCard({ contact, onSaved }: { contact: Contact; onSaved: (c: Contact) => void }) {
  const toast = useToast();
  const { data: defs } = useLoad(() => crmApi.customFields(), []);
  const [values, setValues] = useState<Values>({});
  const [saving, setSaving] = useState(false);
  const snapshot = JSON.stringify(contact.fields ?? {});

  useEffect(() => {
    if (defs) setValues(toForm(defs, contact.fields));
  }, [defs, snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!defs) return null;
  if (!defs.length) {
    return (
      <Card>
        <CardHeader title="Champs personnalisés" icon={Braces} />
        <p className="text-sm text-slate-500">
          Aucun champ défini.{' '}
          <Link to="/contacts?tab=fields" className="font-medium text-brand-700 hover:underline">
            Créer un champ
          </Link>
        </p>
      </Card>
    );
  }

  const initial = toForm(defs, contact.fields);
  const dirty = defs.some((d) => values[d.key] !== initial[d.key]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const fields: Record<string, string | number | boolean | null> = {};
    for (const d of defs) {
      if (values[d.key] === initial[d.key]) continue;
      const v = values[d.key];
      fields[d.key] = d.type === 'checkbox' ? v === true : v === '' ? null : d.type === 'number' ? Number(v) : String(v);
    }
    setSaving(true);
    try {
      onSaved(await api.updateContact(contact.id, { fields }));
      toast.success('Champs mis à jour');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const set = (k: string, v: string | boolean) => setValues({ ...values, [k]: v });

  return (
    <Card>
      <CardHeader
        title="Champs personnalisés"
        icon={Braces}
        actions={
          <Link to="/contacts?tab=fields" className="text-xs font-medium text-slate-500 hover:text-slate-900">
            Gérer
          </Link>
        }
      />
      <form onSubmit={save} className="space-y-4">
        {defs.map((d) =>
          d.type === 'checkbox' ? (
            <Toggle key={d.key} checked={values[d.key] === true} onChange={(v) => set(d.key, v)} label={d.label} />
          ) : (
            <Field key={d.key} label={d.label}>
              {d.type === 'select' ? (
                <Select value={String(values[d.key] ?? '')} onChange={(e) => set(d.key, e.target.value)}>
                  <option value="">—</option>
                  {/* a value removed from the options stays visible */}
                  {[...d.options, ...(values[d.key] && !d.options.includes(String(values[d.key])) ? [String(values[d.key])] : [])].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
              ) : (
                <Input
                  type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'}
                  step={d.type === 'number' ? 'any' : undefined}
                  value={String(values[d.key] ?? '')}
                  onChange={(e) => set(d.key, e.target.value)}
                />
              )}
            </Field>
          ),
        )}
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!dirty}>
            Enregistrer
          </Button>
        </div>
      </form>
    </Card>
  );
}

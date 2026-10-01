// Contacts → « Champs personnalisés »: definitions of the account (label, key, type, list options).
import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Braces, Pencil, Plus, Trash } from 'lucide-react';
import { CUSTOM_FIELD_TYPE_LABELS, CUSTOM_FIELD_TYPES, type CustomField, type CustomFieldType } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import { useLoad } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Skeleton, Textarea } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

const parseOptions = (s: string) => s.split('\n').map((o) => o.trim()).filter(Boolean);

export function FieldsTab() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, error, reload, setData } = useLoad(() => crmApi.customFields(), []);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [options, setOptions] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState<CustomField | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await crmApi.createCustomField({ label: label.trim(), type, key: key.trim() || undefined, options: type === 'select' ? parseOptions(options) : undefined });
      setLabel('');
      setKey('');
      setOptions('');
      reload();
      toast.success('Champ créé');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: CustomField) => {
    const ok = await confirm({
      title: `Supprimer le champ « ${f.label} » ?`,
      message: 'Les valeurs enregistrées sur vos contacts seront définitivement effacées. Les segments et automatisations qui l’utilisent ne le trouveront plus.',
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await crmApi.deleteCustomField(f.id);
      reload();
      toast.success('Champ supprimé');
    } catch (err) {
      toast.error(err);
    }
  };

  const move = async (i: number, dir: -1 | 1) => {
    if (!data) return;
    const next = data.slice();
    const [x] = next.splice(i, 1);
    next.splice(i + dir, 0, x);
    setData(next);
    try {
      setData(await crmApi.reorderCustomFields(next.map((f) => f.id)));
    } catch (err) {
      toast.error(err);
      reload();
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="h-fit">
        <h3 className="text-base font-semibold text-slate-900">Nouveau champ</h3>
        <p className="mt-1 text-sm text-slate-500">
          Stockez des informations propres à votre activité (entreprise, budget, date d’anniversaire…). Utilisables dans les segments, les formulaires, l’import CSV et les emails.
        </p>
        <form onSubmit={create} className="mt-4 space-y-3">
          <Field label="Libellé">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ex. Entreprise" required maxLength={80} />
          </Field>
          <Field
            label="Type"
            hint={
              type === 'datetime'
                ? 'Saisie et affichage dans votre fuseau horaire ; enregistrée en UTC. Import CSV, formulaires et API sans fuseau : heure de Paris (JJ/MM/AAAA HH:mm accepté).'
                : undefined
            }
          >
            <Select value={type} onChange={(e) => setType(e.target.value as CustomFieldType)}>
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {CUSTOM_FIELD_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {type === 'select' && (
            <Field label="Options" hint="Une option par ligne.">
              <Textarea rows={4} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={'Débutant\nIntermédiaire\nExpert'} />
            </Field>
          )}
          <Field label="Clé (facultatif)" hint="Générée depuis le libellé si vide. Non modifiable ensuite : {{field.cle}} dans vos emails.">
            <Input value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} placeholder="entreprise" pattern="[a-z][a-z0-9_]{0,39}" className="font-mono" />
          </Field>
          <Button type="submit" icon={Plus} loading={saving} disabled={!label.trim() || (type === 'select' && !parseOptions(options).length)}>
            Créer le champ
          </Button>
        </form>
      </Card>

      <Card padded={false} className="overflow-hidden lg:col-span-2">
        {error && !data ? (
          <div className="p-5">
            <ErrorState message={error} onRetry={reload} />
          </div>
        ) : !data ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : data.length === 0 ? (
          <EmptyState icon={Braces} title="Aucun champ personnalisé" description="Créez votre premier champ pour enrichir vos fiches contact." className="m-5 border-0" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.map((f, i) => (
              <li key={f.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <Braces size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">{f.label}</p>
                  <p className="truncate font-mono text-xs text-slate-500">
                    {`{{field.${f.key}}}`}
                    {f.type === 'select' && <span className="ml-2 font-sans">· {f.options.join(', ')}</span>}
                  </p>
                </div>
                <Badge tone="slate">{CUSTOM_FIELD_TYPE_LABELS[f.type]}</Badge>
                <div className="flex items-center opacity-0 transition-opacity group-hover:opacity-100">
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Monter">
                    <ArrowUp size={15} />
                  </button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30" disabled={i === data.length - 1} onClick={() => move(i, 1)} title="Descendre">
                    <ArrowDown size={15} />
                  </button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={() => setEditing(f)} title="Modifier">
                    <Pencil size={15} />
                  </button>
                  <button className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" onClick={() => remove(f)} title="Supprimer">
                    <Trash size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <EditFieldModal
        field={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    </div>
  );
}

function EditFieldModal({ field, onClose, onSaved }: { field: CustomField | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [options, setOptions] = useState('');
  const [saving, setSaving] = useState(false);
  const [current, setCurrent] = useState<number | null>(null);
  if (field && current !== field.id) {
    setCurrent(field.id);
    setLabel(field.label);
    setOptions(field.options.join('\n'));
  }
  if (!field && current !== null) setCurrent(null);
  const save = async () => {
    if (!field) return;
    setSaving(true);
    try {
      await crmApi.updateCustomField(field.id, { label: label.trim(), ...(field.type === 'select' ? { options: parseOptions(options) } : {}) });
      toast.success('Champ mis à jour');
      onSaved();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={!!field}
      onClose={() => {
        setCurrent(null);
        onClose();
      }}
      title="Modifier le champ"
      description={field ? `Clé ${field.key} · ${CUSTOM_FIELD_TYPE_LABELS[field.type]} (la clé et le type ne sont pas modifiables).` : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={save} loading={saving} disabled={!label.trim()}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Libellé">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </Field>
        {field?.type === 'select' && (
          <Field label="Options" hint="Une option par ligne. Retirer une option ne modifie pas les valeurs déjà enregistrées.">
            <Textarea rows={6} value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

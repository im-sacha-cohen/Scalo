// Contacts list: bulk action bar (selected ids, or every contact matching the current filters).
import { useState } from 'react';
import { BellOff, Braces, ChevronDown, Tag as TagIcon, Tags, Trash, UserMinus, UserPlus, X } from 'lucide-react';
import type { BulkAction, BulkSelection, CustomField } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import type { CrmRefs } from '../../lib/crm-refs';
import { fmtNumber } from '../../lib/format';
import { Button, Field, Input, Select } from '../../components/ui';
import { DropdownMenu } from '../../components/Menu';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

type Kind = BulkAction['type'];

const TITLES: Record<Kind, string> = {
  add_tag: 'Ajouter un tag',
  remove_tag: 'Retirer un tag',
  enroll: 'Inscrire à une campagne',
  unenroll: 'Retirer d’une campagne',
  set_field: 'Définir un champ',
  unsubscribe: 'Désinscrire des emails',
  delete: 'Supprimer',
};

export function BulkBar({
  selectedCount,
  total,
  allMatching,
  onSelectAll,
  onClear,
  selection,
  refs,
  onDone,
}: {
  selectedCount: number;
  total: number;
  allMatching: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  selection: BulkSelection;
  refs: CrmRefs;
  onDone: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [kind, setKind] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const n = allMatching ? total : selectedCount;
  const who = `${fmtNumber(n)} contact${n > 1 ? 's' : ''}`;

  const run = async (action: BulkAction) => {
    setBusy(true);
    try {
      const r = await crmApi.bulk(selection, action);
      toast.success(`${TITLES[action.type]} : ${fmtNumber(r.processed)} contact${r.processed > 1 ? 's' : ''} modifié${r.processed > 1 ? 's' : ''} sur ${fmtNumber(r.matched)}`);
      setKind(null);
      onDone();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  const start = async (k: Kind) => {
    if (k === 'delete') {
      const ok = await confirm({
        title: `Supprimer ${who} ?`,
        message: 'Les contacts sélectionnés et tout leur historique seront définitivement supprimés. Cette action est irréversible.',
        confirmLabel: `Supprimer ${who}`,
      });
      if (ok) await run({ type: 'delete' });
      return;
    }
    if (k === 'unsubscribe') {
      const ok = await confirm({
        title: `Désinscrire ${who} ?`,
        message: 'Ils ne recevront plus aucune newsletter ni email de campagne (leurs campagnes en cours sont arrêtées).',
        confirmLabel: 'Désinscrire',
      });
      if (ok) await run({ type: 'unsubscribe' });
      return;
    }
    setKind(k);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-brand-100 bg-brand-50/70 px-4 py-2.5 text-sm">
        <span className="font-medium text-brand-800">
          {allMatching ? `Les ${who} correspondants sont sélectionnés` : `${who} sélectionné${n > 1 ? 's' : ''}`}
        </span>
        {!allMatching && total > selectedCount && (
          <button className="font-medium text-brand-700 underline-offset-2 hover:underline" onClick={onSelectAll}>
            Sélectionner les {fmtNumber(total)} contacts correspondants
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu
            width={250}
            trigger={({ toggle, ref }) => (
              <Button ref={ref as never} size="sm" iconRight={ChevronDown} onClick={toggle} loading={busy}>
                Actions
              </Button>
            )}
            items={[
              { label: TITLES.add_tag, icon: TagIcon, onClick: () => start('add_tag') },
              { label: TITLES.remove_tag, icon: Tags, onClick: () => start('remove_tag') },
              'sep',
              { label: TITLES.enroll, icon: UserPlus, onClick: () => start('enroll') },
              { label: TITLES.unenroll, icon: UserMinus, onClick: () => start('unenroll') },
              { label: TITLES.set_field, icon: Braces, onClick: () => start('set_field'), disabled: !refs.fields.length },
              'sep',
              { label: TITLES.unsubscribe, icon: BellOff, onClick: () => start('unsubscribe') },
              { label: TITLES.delete, icon: Trash, onClick: () => start('delete'), danger: true },
            ]}
          />
          <Button size="sm" variant="ghost" icon={X} onClick={onClear}>
            Annuler
          </Button>
        </div>
      </div>
      <ActionModal kind={kind} who={who} refs={refs} busy={busy} onClose={() => setKind(null)} onRun={run} />
    </>
  );
}

function FieldValueInput({ field, value, onChange }: { field: CustomField | undefined; value: string; onChange: (v: string) => void }) {
  if (!field) return null;
  if (field.type === 'select') {
    return (
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">(vider le champ)</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    );
  }
  if (field.type === 'checkbox') {
    return (
      <Select value={value || 'true'} onChange={(e) => onChange(e.target.value)}>
        <option value="true">Coché</option>
        <option value="false">Non coché</option>
      </Select>
    );
  }
  return (
    <Input
      type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Laisser vide pour vider le champ"
    />
  );
}

function ActionModal({ kind, who, refs, busy, onClose, onRun }: { kind: Kind | null; who: string; refs: CrmRefs; busy: boolean; onClose: () => void; onRun: (a: BulkAction) => void }) {
  const [tagName, setTagName] = useState('');
  const [tagId, setTagId] = useState('');
  const [campaignId, setCampaignId] = useState('');
  const [fieldKey, setFieldKey] = useState('');
  const [value, setValue] = useState('');
  const field = refs.fields.find((f) => f.key === (fieldKey || refs.fields[0]?.key));

  const action = (): BulkAction | null => {
    switch (kind) {
      case 'add_tag':
        return tagName.trim() ? { type: 'add_tag', tag_name: tagName.trim() } : null;
      case 'remove_tag':
        return tagId ? { type: 'remove_tag', tag_id: Number(tagId) } : null;
      case 'enroll':
      case 'unenroll':
        return campaignId ? { type: kind, campaign_id: Number(campaignId) } : null;
      case 'set_field':
        if (!field) return null;
        return {
          type: 'set_field',
          key: field.key,
          value: value === '' ? null : field.type === 'checkbox' ? value !== 'false' : field.type === 'number' ? Number(value) : value,
        };
      default:
        return null;
    }
  };
  const a = action();

  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={kind ? TITLES[kind] : ''}
      description={`Action appliquée à ${who}. Les effets habituels s’appliquent (campagnes déclenchées par un tag, historique, automatisations).`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => a && onRun(a)} loading={busy} disabled={!a}>
            Appliquer
          </Button>
        </>
      }
    >
      {kind === 'add_tag' && (
        <Field label="Tag" hint="Créé s’il n’existe pas.">
          <Input list="bulk-tags" icon={TagIcon} value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder="ex. client" autoFocus />
          <datalist id="bulk-tags">
            {refs.tags.map((t) => (
              <option key={t.id} value={t.name} />
            ))}
          </datalist>
        </Field>
      )}
      {kind === 'remove_tag' && (
        <Field label="Tag">
          <Select value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">Choisir un tag…</option>
            {refs.tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {(kind === 'enroll' || kind === 'unenroll') && (
        <Field label="Campagne" hint={kind === 'enroll' ? 'Les contacts non confirmés (double opt-in) ou déjà inscrits sont ignorés.' : undefined}>
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            <option value="">Choisir une campagne…</option>
            {refs.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {kind === 'set_field' && (
        <div className="space-y-4">
          <Field label="Champ">
            <Select
              value={field?.key ?? ''}
              onChange={(e) => {
                setFieldKey(e.target.value);
                setValue('');
              }}
            >
              {refs.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Valeur">
            <FieldValueInput field={field} value={value} onChange={setValue} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

// Sidebar: the workspace the app works on (one per business), switching, creation, renaming.
// Switching reloads the app on the other workspace (lib/api.ts → switchWorkspace).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronsUpDown, Pencil, Plus } from 'lucide-react';
import type { Workspace } from '@scalo/shared';
import { api, switchWorkspace } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { Button, Field, Input, cx } from './ui';
import { Modal } from './Modal';
import { useToast } from './Toast';

const tile = (name: string) => (name.trim()[0] ?? '?').toUpperCase();

function NameDialog({ editing, onClose, onDone }: { editing: Workspace | null | 'new'; onClose: () => void; onDone: (w: Workspace, created: boolean) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setName(editing && editing !== 'new' ? editing.name : ''), [editing]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = editing === 'new';
      const w = created ? await api.createWorkspace(name) : await api.renameWorkspace((editing as Workspace).id, name);
      onDone(w, created);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!editing}
      onClose={onClose}
      title={editing === 'new' ? 'Nouvel espace de travail' : 'Renommer l’espace'}
      description={editing === 'new' ? 'Un espace par business : contacts, tunnels, emails, ventes et réglages y sont séparés de vos autres espaces.' : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="workspace-name" loading={busy} disabled={!name.trim()}>
            {editing === 'new' ? 'Créer l’espace' : 'Enregistrer'}
          </Button>
        </>
      }
    >
      <form id="workspace-name" onSubmit={submit}>
        <Field label="Nom de l’espace">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Ex. : Coaching, Boutique, Agence…" />
        </Field>
      </form>
    </Modal>
  );
}

export function WorkspaceSwitcher() {
  const toast = useToast();
  const { data, reload } = useLoad(() => api.workspaces(), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Workspace | null | 'new'>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (!data) return <div className="mx-2.5 h-[46px] rounded-xl bg-white/5" />;
  const current = data.workspaces.find((w) => w.id === data.current);
  // nothing to switch to and nothing to create (team member of a single account): just the name
  const interactive = data.can_create || data.workspaces.length > 1;

  return (
    <div ref={ref} className="relative px-2.5">
      <button
        onClick={() => interactive && setOpen((o) => !o)}
        className={cx('flex w-full items-center gap-2.5 rounded-xl border border-white/10 p-1.5 text-left transition-colors', interactive && 'hover:bg-white/5', open && 'bg-white/5')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-lime-400 font-display text-sm font-extrabold text-ink">{tile(current?.name ?? '')}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium tracking-wide text-brand-300 uppercase">Espace</span>
          <span className="block truncate text-[13px] font-semibold text-white">{current?.name ?? '…'}</span>
        </span>
        {interactive && <ChevronsUpDown size={15} className="text-brand-300" />}
      </button>

      {open && (
        <div role="menu" className="absolute top-full right-2.5 left-2.5 z-40 mt-1.5 animate-pop-in overflow-hidden rounded-xl bg-white p-1 shadow-pop">
          <p className="px-2.5 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Vos espaces</p>
          <ul className="max-h-72 overflow-y-auto">
            {data.workspaces.map((w) => (
              <li key={w.id} className="group flex items-center">
                <button
                  role="menuitem"
                  onClick={() => (w.id === data.current ? setOpen(false) : switchWorkspace(w.id))}
                  className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100"
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-brand-100 text-xs font-bold text-brand-700">{tile(w.name)}</span>
                  <span className="min-w-0 flex-1 truncate">{w.name}</span>
                  {w.id === data.current && <Check size={15} className="shrink-0 text-brand-600" />}
                </button>
                {w.role === 'owner' && (
                  <button
                    onClick={() => {
                      setOpen(false);
                      setEditing(w);
                    }}
                    className="mr-1 rounded-md p-1.5 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-100 hover:text-slate-700 focus-visible:opacity-100"
                    aria-label={`Renommer ${w.name}`}
                  >
                    <Pencil size={13} />
                  </button>
                )}
              </li>
            ))}
          </ul>
          {data.can_create && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setEditing('new');
              }}
              className="mt-1 flex w-full items-center gap-2.5 rounded-lg border-t border-slate-100 px-2.5 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50"
            >
              <Plus size={15} /> Nouvel espace
            </button>
          )}
        </div>
      )}

      <NameDialog
        editing={editing}
        onClose={() => setEditing(null)}
        onDone={(w, created) => {
          setEditing(null);
          if (created) {
            toast.success(`Espace « ${w.name} » créé`);
            switchWorkspace(w.id);
          } else {
            toast.success('Espace renommé');
            void reload();
          }
        }}
      />
    </div>
  );
}

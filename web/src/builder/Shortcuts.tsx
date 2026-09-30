import { Modal } from '../components/Modal';
import { Kbd } from '../components/ui';

const GROUPS: { title: string; items: [string, string[]][] }[] = [
  {
    title: 'Général',
    items: [
      ['Enregistrer', ['Ctrl', 'S']],
      ['Annuler', ['Ctrl', 'Z']],
      ['Rétablir', ['Ctrl', 'Maj', 'Z']],
      ['Afficher les raccourcis', ['?']],
      ['Quitter l’aperçu / désélectionner', ['Échap']],
    ],
  },
  {
    title: 'Bloc sélectionné',
    items: [
      ['Éditer le texte', ['Entrée']],
      ['Dupliquer', ['Ctrl', 'D']],
      ['Copier / couper', ['Ctrl', 'C / X']],
      ['Coller après la sélection', ['Ctrl', 'V']],
      ['Monter / descendre', ['Alt', '↑ / ↓']],
      ['Supprimer', ['Suppr']],
    ],
  },
  {
    title: 'À la souris',
    items: [
      ['Éditer un texte sur la page', ['Double-clic']],
      ['Plus d’actions sur un bloc', ['Clic droit']],
      ['Déplacer un bloc', ['Glisser']],
    ],
  },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Raccourcis clavier" size="md">
      <div className="space-y-5">
        {GROUPS.map((g) => (
          <div key={g.title}>
            <p className="mb-1.5 text-xs font-medium text-slate-400">{g.title}</p>
            <ul className="divide-y divide-slate-100">
              {g.items.map(([label, keys]) => (
                <li key={label} className="flex items-center justify-between gap-4 py-1.5 text-sm text-slate-700">
                  {label}
                  <span className="flex shrink-0 items-center gap-1">
                    {keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs text-slate-400">Sur Mac, Ctrl correspond à ⌘.</p>
      </div>
    </Modal>
  );
}

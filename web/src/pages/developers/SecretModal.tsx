import { TriangleAlert } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui';
import { CopyValue } from '../oauth/common';

/** Shows a freshly created / rotated client secret, once. */
export function SecretModal({ clientId, secret, onClose, title = 'Identifiants de l’application' }: { clientId: string; secret: string | null; onClose: () => void; title?: string }) {
  return (
    <Modal
      open={!!secret}
      onClose={onClose}
      title={title}
      footer={
        <Button onClick={onClose} data-autofocus>
          J’ai copié le secret
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2.5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <p>
            Copiez le <strong>client_secret</strong> maintenant : il ne sera plus jamais affiché (seule son empreinte est conservée). Gardez-le côté serveur, jamais dans du code
            exécuté par le navigateur ou une application mobile.
          </p>
        </div>
        <div>
          <p className="mb-1 font-mono text-xs text-slate-500">client_id</p>
          <CopyValue value={clientId} />
        </div>
        <div>
          <p className="mb-1 font-mono text-xs text-slate-500">client_secret</p>
          {secret && <CopyValue value={secret} secret />}
        </div>
      </div>
    </Modal>
  );
}

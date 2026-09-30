import { useMemo, useState } from 'react';
import { renderEmailDocument, type PageContent } from '@scalo/shared';
import { cx } from '../../components/ui';
import { Modal } from '../../components/Modal';

export const SAMPLE_VARS = { first_name: 'Marie', last_name: 'Dupont', email: 'marie@exemple.com' };

export function EmailPreview({ open, onClose, content, subject }: { open: boolean; onClose: () => void; content: PageContent; subject: string }) {
  const [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const html = useMemo(
    () =>
      open
        ? renderEmailDocument(content, {
            subject,
            vars: SAMPLE_VARS,
            baseUrl: window.location.origin,
            footer: 'Votre entreprise · 1 rue de l’exemple, 75000 Paris<br><a href="#" style="color:#94a3b8">Se désinscrire</a>',
          })
        : '',
    [open, content, subject],
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title="Aperçu de l’email"
      description={
        <span className="flex items-center justify-between gap-3">
          <span>
            Objet : <strong className="text-slate-700">{subject || 'Sans objet'}</strong> — variables remplacées par un contact d’exemple.
          </span>
          <span className="inline-flex shrink-0 rounded-lg bg-slate-100 p-0.5">
            {(['desktop', 'mobile'] as const).map((w) => (
              <button key={w} onClick={() => setWidth(w)} className={cx('rounded-md px-2.5 py-1 text-xs font-medium', width === w ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500')}>
                {w === 'desktop' ? 'Ordinateur' : 'Mobile'}
              </button>
            ))}
          </span>
        </span>
      }
      bodyClassName="p-0"
    >
      <div className="flex h-[70vh] justify-center overflow-hidden rounded-b-2xl bg-slate-200">
        <iframe title="Aperçu" sandbox="" srcDoc={html} className="h-full border-0 bg-white transition-[width]" style={{ width: width === 'mobile' ? 390 : '100%' }} />
      </div>
    </Modal>
  );
}


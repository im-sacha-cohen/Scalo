// Funnels → "Importer": JSON export file of a funnel (from this or another account / instance).
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileJson, Upload } from 'lucide-react';
import { growthApi } from '../../../lib/growth-api';
import { Button, cx } from '../../../components/ui';
import { Modal } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';

const MAX_BYTES = 2 * 1024 * 1024;

export function ImportFunnelModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [importedId, setImportedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setError(null);
      setWarnings(null);
      setImportedId(null);
    }
  }, [open]);

  const pick = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > MAX_BYTES) return setError('Fichier trop volumineux (2 Mo maximum).');
    setFile(f);
  };

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      let data: unknown;
      try {
        data = JSON.parse(await file.text());
      } catch {
        throw new Error('Ce fichier n’est pas un JSON valide.');
      }
      const r = await growthApi.importFunnel(data);
      toast.success('Tunnel importé');
      if (r.warnings.length) {
        setWarnings(r.warnings);
        setImportedId(r.id);
      } else {
        onClose();
        navigate(`/funnels/${r.id}`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Importer un tunnel"
      description="Fichier .json obtenu avec « Exporter le tunnel ». Une copie indépendante est créée dans votre compte, avec une nouvelle adresse."
      footer={
        importedId ? (
          <Button onClick={() => { onClose(); navigate(`/funnels/${importedId}`); }}>Ouvrir le tunnel importé</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Annuler
            </Button>
            <Button icon={Upload} onClick={submit} loading={busy} disabled={!file}>
              Importer
            </Button>
          </>
        )
      }
    >
      {warnings ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-800">Import terminé. À vérifier :</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-amber-800">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              pick(e.dataTransfer.files[0]);
            }}
            className={cx(
              'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-sm transition-colors',
              drag ? 'border-brand-400 bg-brand-50' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50',
            )}
          >
            <FileJson size={28} className="text-slate-400" />
            {file ? <span className="font-medium text-slate-800">{file.name}</span> : <span className="text-slate-600">Déposez le fichier ici ou cliquez pour le choisir</span>}
            <span className="text-xs text-slate-400">JSON, 2 Mo maximum</span>
          </button>
          <input ref={input} type="file" accept="application/json,.json" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
          {error && (
            <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {error}
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

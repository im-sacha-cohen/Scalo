import { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Link2, Trash, Upload } from 'lucide-react';
import { api, type UploadItem } from '../lib/api';
import { Modal } from '../components/Modal';
import { Button, Spinner, cx } from '../components/ui';
import { useToast } from '../components/Toast';

const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);

export function MediaLibrary({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (url: string) => void }) {
  const toast = useToast();
  const [items, setItems] = useState<UploadItem[] | null>(null);
  const [uploading, setUploading] = useState(0);
  const [over, setOver] = useState(false);
  const [url, setUrl] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    api.uploads().then(setItems).catch((e) => {
      toast.error(e);
      setItems([]);
    });
  }, [toast]);
  useEffect(() => {
    if (open) {
      setUrl('');
      load();
    }
  }, [open, load]);

  const upload = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => ACCEPT.split(',').includes(f.type));
    if (!list.length) {
      toast.error('Formats acceptés : PNG, JPEG, GIF ou WebP (8 Mo max).');
      return;
    }
    setUploading((n) => n + list.length);
    let last: UploadItem | null = null;
    for (const f of list) {
      try {
        last = await api.upload(f);
        setItems((cur) => [last!, ...(cur ?? [])]);
      } catch (e) {
        toast.error(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (last && list.length === 1) onPick(last.url);
  };

  const remove = async (it: UploadItem) => {
    if (!window.confirm('Supprimer cette image ? Elle disparaîtra des pages et emails qui l’utilisent.')) return;
    try {
      await api.deleteUpload(it.name);
      setItems((cur) => (cur ?? []).filter((x) => x.name !== it.name));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Médiathèque" description="Importez vos images ou choisissez-en une déjà importée." size="xl">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
        className={cx(
          'flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-7 text-center transition-colors',
          over ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50/60',
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-100 text-brand-600">{uploading ? <Spinner size={20} /> : <Upload size={20} />}</span>
        <p className="text-sm font-medium text-slate-800">{uploading ? `Import en cours (${uploading})…` : 'Glissez vos images ici'}</p>
        <p className="text-xs text-slate-500">PNG, JPEG, GIF ou WebP · 8 Mo maximum</p>
        <Button size="sm" variant="secondary" icon={ImagePlus} onClick={() => input.current?.click()}>
          Choisir des fichiers
        </Button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) upload(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      <form
        className="mt-4 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const u = url.trim();
          if (!/^https?:\/\//i.test(u)) {
            toast.error('Collez une adresse commençant par https://');
            return;
          }
          onPick(u);
        }}
      >
        <div className="relative flex-1">
          <Link2 size={15} className="absolute top-1/2 left-3 -translate-y-1/2 text-slate-400" />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="…ou collez l’URL d’une image (https://…)"
            className="h-9 w-full rounded-lg border border-slate-200 pr-3 pl-9 text-sm outline-none focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15"
          />
        </div>
        <Button type="submit" size="sm" disabled={!url.trim()}>
          Utiliser
        </Button>
      </form>

      <div className="mt-5">
        <p className="mb-2 text-xs font-medium text-slate-500">Mes images {items ? `(${items.length})` : ''}</p>
        {!items ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-lg bg-slate-50 py-8 text-center text-sm text-slate-500">Aucune image importée pour l’instant.</p>
        ) : (
          <div className="scalo-scroll grid max-h-[340px] grid-cols-3 gap-3 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
            {items.map((it) => (
              <div key={it.name} className="group relative overflow-hidden rounded-lg border border-slate-200 bg-[repeating-conic-gradient(#f1f5f9_0%_25%,#fff_0%_50%)] bg-[length:14px_14px]">
                <button type="button" onClick={() => onPick(it.url)} className="block aspect-square w-full" title="Utiliser cette image">
                  <img src={it.url} alt="" loading="lazy" className="h-full w-full object-contain transition-transform group-hover:scale-105" />
                </button>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-slate-900/70 to-transparent px-2 pt-4 pb-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                  {fmtSize(it.size)}
                </div>
                <button
                  type="button"
                  onClick={() => remove(it)}
                  className="absolute top-1.5 right-1.5 flex h-7 w-7 items-center justify-center rounded-md bg-white/90 text-slate-500 opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-rose-600"
                  title="Supprimer"
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

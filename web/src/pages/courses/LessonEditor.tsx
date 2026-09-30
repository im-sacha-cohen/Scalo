import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download, ExternalLink, Eye, GraduationCap, Paperclip, Trash, Upload } from 'lucide-react';
import { flattenBlocks, LESSON_FILE_EXTENSIONS, LESSON_FORBIDDEN_BLOCKS, type Lesson, type LessonFile, type PageContent } from '@scalo/shared';
import { downloadBlob } from '../../lib/api';
import { coursesApi } from '../../lib/courses-api';
import { useBeforeUnload, useLoad } from '../../lib/hooks';
import { Builder, type BuilderHandle, type BuilderPanel } from '../../builder/Builder';
import { PreviewMenu, SaveButton, SaveStatus } from '../../builder/bar';
import { Badge, ErrorState, Field, Input, Select, Spinner, Toggle } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useUnsavedGuard } from '../../components/useUnsavedGuard';

/** Remounts the editor when switching lesson, so no state leaks between lessons. */
export function LessonEditorPage() {
  const { lessonId } = useParams();
  return <LessonEditor key={lessonId} />;
}

interface Meta {
  title: string;
  status: Lesson['status'];
  free_preview: boolean;
  drip_days: number;
  video_url: string;
}

const metaOf = (l: Lesson): Meta => ({ title: l.title, status: l.status, free_preview: l.free_preview, drip_days: l.drip_days, video_url: l.video_url ?? '' });
const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
/** Blocks removed from lessons by the server (owner code and opt-in forms have no place in the members area). */
const hasForbidden = (c: PageContent) => flattenBlocks(c.blocks ?? []).some((b) => LESSON_FORBIDDEN_BLOCKS.includes(b.type));

function LessonEditor() {
  const { id, lessonId } = useParams();
  const courseId = Number(id);
  const lid = Number(lessonId);
  const toast = useToast();

  const { data, error, reload } = useLoad(async () => {
    const [lesson, course] = await Promise.all([coursesApi.lesson(lid), coursesApi.course(courseId)]);
    return { lesson, course };
  }, [lid, courseId]);

  const [content, setContent] = useState<PageContent | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [files, setFiles] = useState<LessonFile[]>([]);
  const [savedJson, setSavedJson] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const failedJson = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const builder = useRef<BuilderHandle>(null);
  const ready = !!content && !!meta;
  // the lesson settings (status, video, drip, files) are the first thing to check: open their panel
  useEffect(() => {
    if (ready) builder.current?.openPanel('lesson');
  }, [ready]);

  useEffect(() => {
    if (!data) return;
    const c = data.lesson.content!;
    const m = metaOf(data.lesson);
    setContent(c);
    setMeta(m);
    setFiles(data.lesson.files ?? []);
    setSavedJson(JSON.stringify({ c, m }));
  }, [data]);

  const json = useMemo(() => (content && meta ? JSON.stringify({ c: content, m: meta }) : ''), [content, meta]);
  const dirty = !!json && json !== savedJson;
  useBeforeUnload(dirty);
  useUnsavedGuard(dirty);

  const stateRef = useRef({ content, meta });
  stateRef.current = { content, meta };

  const save = useCallback(async () => {
    const { content: c, meta: m } = stateRef.current;
    if (!c || !m) return false;
    if (!m.title.trim()) {
      toast.error('Le titre de la leçon est obligatoire.');
      failedJson.current = JSON.stringify({ c, m });
      return false;
    }
    setSaving(true);
    try {
      const saved = await coursesApi.updateLesson(lid, { content: c, title: m.title.trim(), status: m.status, free_preview: m.free_preview, drip_days: m.drip_days, video_url: m.video_url.trim() || null });
      if (hasForbidden(c)) {
        // the server removed them: show what is really stored
        toast.info('Les blocs HTML personnalisé, formulaire et paiement ne sont pas disponibles dans les leçons : ils ont été retirés.');
        setContent(saved.content!);
        setSavedJson(JSON.stringify({ c: saved.content!, m }));
      } else {
        setSavedJson(JSON.stringify({ c, m }));
      }
      failedJson.current = null;
      return true;
    } catch (e) {
      failedJson.current = JSON.stringify({ c, m });
      toast.error(e);
      return false;
    } finally {
      setSaving(false);
    }
  }, [lid, toast]);

  // autosave: 2.5 s after the last change (not retried for the same state after a failure)
  useEffect(() => {
    if (!dirty || saving || failedJson.current === json) return;
    const t = setTimeout(() => save(), 2500);
    return () => clearTimeout(t);
  }, [json, dirty, saving, save]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);

  const openPreview = async () => {
    if (!data?.lesson.preview_url) return;
    const url = data.lesson.preview_url;
    if (!dirty) {
      window.open(url, '_blank');
      return;
    }
    // open synchronously (avoids popup blockers), then navigate once saved
    const w = window.open('about:blank', '_blank');
    const ok = await save();
    if (w) {
      if (ok) w.location.href = url;
      else w.close();
    }
  };

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    for (const f of Array.from(list)) {
      try {
        const added = await coursesApi.uploadFile(lid, f);
        setFiles((cur) => [...cur, added]);
      } catch (e) {
        toast.error(e);
      }
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  };
  const removeFile = async (f: LessonFile) => {
    try {
      await coursesApi.deleteFile(f.id);
      setFiles((cur) => cur.filter((x) => x.id !== f.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const download = async (f: LessonFile) => {
    try {
      downloadBlob(await coursesApi.downloadFile(f.id), f.name);
    } catch (e) {
      toast.error(e);
    }
  };

  if (error && !data) {
    return (
      <div className="mx-auto max-w-xl p-10">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }
  if (!data || !content || !meta) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-slate-100 text-sm text-slate-500">
        <Spinner size={32} />
        Chargement de l’éditeur…
      </div>
    );
  }

  const set = (patch: Partial<Meta>) => setMeta((m) => (m ? { ...m, ...patch } : m));
  const panels: BuilderPanel[] = [
    {
      id: 'lesson',
      label: 'Réglages de la leçon',
      icon: GraduationCap,
      dot: meta.status !== 'published',
      render: () => (
        <div className="scalo-scroll flex-1 space-y-5 overflow-y-auto border-t border-slate-100 px-4 py-4">
          <Field label="Titre">
            <Input value={meta.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} />
          </Field>
          <Field label="Statut" hint="Une leçon en brouillon n’est visible que dans l’aperçu propriétaire.">
            <Select value={meta.status} onChange={(e) => set({ status: e.target.value as Meta['status'] })}>
              <option value="draft">Brouillon</option>
              <option value="published">Publiée</option>
            </Select>
          </Field>
          <Field label="Vidéo" hint="Lien YouTube, Vimeo ou fichier vidéo (.mp4, .webm). Affichée au-dessus du contenu.">
            <Input value={meta.video_url} onChange={(e) => set({ video_url: e.target.value })} placeholder="https://…" />
          </Field>
          <Field label="Diffusion progressive" hint="Nombre de jours après l’obtention de l’accès. 0 : disponible tout de suite.">
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                max={3650}
                value={meta.drip_days}
                onChange={(e) => set({ drip_days: Math.max(0, Math.min(3650, Math.round(Number(e.target.value) || 0))) })}
                className="w-24"
              />
              <span className="text-sm text-slate-500">jour{meta.drip_days > 1 ? 's' : ''} après l’accès</span>
            </div>
          </Field>
          <Toggle
            checked={meta.free_preview}
            onChange={(v) => set({ free_preview: v })}
            label="Aperçu gratuit"
            description="Lisible par tout le monde, sans connexion ni accès à la formation (fichiers compris)."
          />
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium text-slate-700">Fichiers à télécharger</span>
              <button type="button" onClick={() => fileInput.current?.click()} disabled={uploading} className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline disabled:opacity-50">
                {uploading ? <Spinner size={12} /> : <Upload size={12} />} Ajouter
              </button>
            </div>
            <input ref={fileInput} type="file" multiple hidden accept={LESSON_FILE_EXTENSIONS.map((e) => `.${e}`).join(',')} onChange={(e) => upload(e.target.files)} />
            {files.length === 0 ? (
              <p className="text-xs text-slate-500">PDF, archives, documents, audio… 25 Mo maximum par fichier. Réservés aux membres ayant accès à la leçon.</p>
            ) : (
              <ul className="space-y-1.5">
                {files.map((f) => (
                  <li key={f.id} className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm">
                    <Paperclip size={13} className="shrink-0 text-slate-400" />
                    <span className="min-w-0 flex-1 truncate" title={f.name}>
                      {f.name}
                    </span>
                    <span className="shrink-0 text-xs text-slate-400">{fmtSize(f.size)}</span>
                    <button type="button" onClick={() => download(f)} className="shrink-0 text-slate-400 hover:text-slate-700" title="Télécharger" aria-label={`Télécharger ${f.name}`}>
                      <Download size={14} />
                    </button>
                    <button type="button" onClick={() => removeFile(f)} className="shrink-0 text-slate-400 hover:text-rose-600" title="Supprimer" aria-label={`Supprimer ${f.name}`}>
                      <Trash size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Builder
        ref={builder}
        content={content}
        onChange={setContent}
        mode="page"
        title={meta.title}
        panels={panels}
        barStart={
          <>
            <Link
              to={`/courses/${courseId}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              title="Retour à la formation"
              aria-label="Retour à la formation"
            >
              <ArrowLeft size={17} />
            </Link>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" />
            <span className="min-w-0 truncate text-sm">
              <span className="hidden text-slate-400 md:inline">{data.course.title} / </span>
              <span className="font-medium text-slate-900">{meta.title || 'Leçon sans titre'}</span>
            </span>
            <Badge tone={meta.status === 'published' ? 'green' : 'slate'}>{meta.status === 'published' ? 'Publiée' : 'Brouillon'}</Badge>
          </>
        }
        barEnd={({ preview: inEditor, togglePreview }) => (
          <>
            <SaveStatus saving={saving} dirty={dirty} detail="Enregistrement automatique activé" />
            <PreviewMenu
              preview={inEditor}
              onToggle={togglePreview}
              items={[
                { label: inEditor ? 'Revenir à l’édition' : 'Aperçu dans l’éditeur', description: 'Contenu de la leçon, liens désactivés', icon: Eye, onClick: togglePreview },
                { label: 'Aperçu en tant que membre', description: 'Dans l’espace membres, sans enregistrer de progression', icon: ExternalLink, onClick: openPreview },
              ]}
            />
            <SaveButton onClick={save} saving={saving} dirty={dirty} />
          </>
        )}
      />
    </div>
  );
}

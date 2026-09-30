import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BookOpen,
  CalendarClock,
  Check,
  Clock,
  Copy,
  Eye,
  Gift,
  ImagePlus,
  Paperclip,
  Pencil,
  Plus,
  Settings2,
  Tag as TagIcon,
  Trash,
  UserPlus,
  Users,
  Video,
} from 'lucide-react';
import type { Course, CourseModule, CourseStudent, Lesson, Tag } from '@scalo/shared';
import { api } from '../../lib/api';
import { coursesApi } from '../../lib/courses-api';
import { copyText, useLoad } from '../../lib/hooks';
import { contactName, fmtDate, fmtRelative } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, IconButton, Input, PageHeader, PageLoader, Select, Tabs, Textarea, cx } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useConfirm } from '../../components/ConfirmDialog';
import { useToast } from '../../components/Toast';
import { MediaLibrary } from '../../builder/MediaLibrary';

type Tab = 'content' | 'students' | 'settings';

export function CourseDetailPage() {
  const { id } = useParams();
  const courseId = Number(id);
  const [params, setParams] = useSearchParams();
  const tab = (['content', 'students', 'settings'] as Tab[]).find((t) => t === params.get('tab')) ?? 'content';
  const toast = useToast();
  const { data: course, setData, error, reload } = useLoad(() => coursesApi.course(courseId), [courseId]);
  const [publishing, setPublishing] = useState(false);

  if (error && !course) return <ErrorState message={error} onRetry={reload} />;
  if (!course) return <PageLoader />;

  const published = course.status === 'published';
  const togglePublish = async () => {
    setPublishing(true);
    try {
      setData(await coursesApi.updateCourse(course.id, { status: published ? 'draft' : 'published' }));
      toast.success(published ? 'Formation repassée en brouillon' : 'Formation publiée');
    } catch (e) {
      toast.error(e);
    } finally {
      setPublishing(false);
    }
  };

  return (
    <>
      <PageHeader
        back={
          <Link to="/courses" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900">
            <ArrowLeft size={15} /> Formations
          </Link>
        }
        title={
          <span className="flex items-center gap-3">
            <span className="truncate">{course.title}</span>
            <Badge tone={published ? 'green' : 'slate'} dot>
              {published ? 'Publiée' : 'Brouillon'}
            </Badge>
          </span>
        }
        description={course.url.replace(/^https?:\/\//, '')}
        actions={
          <>
            <Button variant="secondary" icon={Eye} onClick={() => window.open(course.preview_url, '_blank')}>
              Aperçu membre
            </Button>
            <Button variant={published ? 'secondary' : 'primary'} loading={publishing} onClick={togglePublish}>
              {published ? 'Repasser en brouillon' : 'Publier'}
            </Button>
          </>
        }
      />
      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={(t) => setParams(t === 'content' ? {} : { tab: t }, { replace: true })}
        tabs={[
          { id: 'content', label: 'Contenu', icon: BookOpen, count: course.lessons_count },
          { id: 'students', label: 'Élèves', icon: Users, count: course.students_count },
          { id: 'settings', label: 'Réglages', icon: Settings2 },
        ]}
      />
      {tab === 'content' && <ContentTab course={course} onChange={setData} reload={reload} />}
      {tab === 'students' && <StudentsTab course={course} onCount={reload} />}
      {tab === 'settings' && <SettingsTab course={course} onChange={setData} />}
    </>
  );
}

// ---------- content: modules & lessons ----------

const swap = <T,>(list: T[], i: number, j: number) => {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

function ContentTab({ course, onChange, reload }: { course: Course; onChange: (c: Course) => void; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const modules = course.modules ?? [];
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState<{ kind: 'module' } | { kind: 'rename'; module: CourseModule } | { kind: 'lesson'; module: CourseModule } | null>(null);

  /** Runs an API call returning the refreshed course. */
  const run = async (fn: () => Promise<Course>) => {
    setBusy(true);
    try {
      onChange(await fn());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const moveModule = (i: number, dir: -1 | 1) => run(() => coursesApi.reorderModules(course.id, swap(modules, i, i + dir).map((m) => m.id)));
  const moveLesson = (mi: number, li: number, dir: -1 | 1) => {
    const m = modules[mi];
    const target = li + dir;
    if (target >= 0 && target < m.lessons.length) return run(() => coursesApi.reorderLessons(m.id, swap(m.lessons, li, target).map((l) => l.id)));
    // first / last lesson of a module: it moves to the end of the previous module / the start of the next one
    const other = modules[mi + dir];
    if (!other) return;
    const ids = other.lessons.map((l) => l.id);
    return run(() => coursesApi.reorderLessons(other.id, dir === -1 ? [...ids, m.lessons[li].id] : [m.lessons[li].id, ...ids]));
  };

  const deleteModule = async (m: CourseModule) => {
    const ok = await confirm({
      title: `Supprimer le module « ${m.title} » ?`,
      message: m.lessons.length ? `Ses ${m.lessons.length} leçon${m.lessons.length > 1 ? 's' : ''} et leurs fichiers seront supprimés définitivement.` : undefined,
      confirmLabel: 'Supprimer',
      tone: 'danger',
    });
    if (ok) await run(() => coursesApi.deleteModule(m.id));
  };
  const deleteLesson = async (l: Lesson) => {
    const ok = await confirm({ title: `Supprimer la leçon « ${l.title} » ?`, message: 'Son contenu, ses fichiers et la progression associée seront supprimés.', confirmLabel: 'Supprimer', tone: 'danger' });
    if (!ok) return;
    try {
      await coursesApi.deleteLesson(l.id);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const toggleLesson = async (l: Lesson) => {
    try {
      await coursesApi.updateLesson(l.id, { status: l.status === 'published' ? 'draft' : 'published' });
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const submitPrompt = async (value: string) => {
    const p = prompt;
    if (!p) return;
    setPrompt(null);
    if (p.kind === 'module') return run(() => coursesApi.createModule(course.id, value));
    if (p.kind === 'rename') return run(() => coursesApi.renameModule(p.module.id, value));
    try {
      const lesson = await coursesApi.createLesson(p.module.id, value);
      navigate(`/courses/${course.id}/lessons/${lesson.id}/edit`);
    } catch (e) {
      toast.error(e);
    }
  };

  const lessonsTotal = modules.reduce((n, m) => n + m.lessons.length, 0);
  return (
    <div className="space-y-5">
      {course.status === 'published' && lessonsTotal > 0 && !modules.some((m) => m.lessons.some((l) => l.status === 'published')) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          La formation est publiée mais aucune leçon ne l’est : vos membres ne voient aucun contenu. Publiez les leçons une à une avec le bouton « Publier ».
        </div>
      )}
      {modules.map((m, mi) => (
        <Card key={m.id} padded={false}>
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold tracking-wide text-slate-400 uppercase">Module {mi + 1}</p>
              <h3 className="truncate font-display text-base font-bold text-ink">{m.title}</h3>
            </div>
            <IconButton icon={Pencil} label="Renommer le module" onClick={() => setPrompt({ kind: 'rename', module: m })} />
            <IconButton icon={ArrowUp} label="Monter le module" disabled={busy || mi === 0} onClick={() => moveModule(mi, -1)} />
            <IconButton icon={ArrowDown} label="Descendre le module" disabled={busy || mi === modules.length - 1} onClick={() => moveModule(mi, 1)} />
            <IconButton icon={Trash} label="Supprimer le module" className="hover:bg-rose-50 hover:text-rose-600" onClick={() => deleteModule(m)} />
          </div>
          {m.lessons.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">Aucune leçon dans ce module.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {m.lessons.map((l, li) => (
                <li key={l.id} className="flex items-center gap-2 px-5 py-2.5">
                  <span className="w-6 shrink-0 text-center text-xs font-medium text-slate-400 tabular-nums">{li + 1}</span>
                  <Link to={`/courses/${course.id}/lessons/${l.id}/edit`} className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700">{l.title}</span>
                    <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={l.status === 'published' ? 'green' : 'slate'}>{l.status === 'published' ? 'Publiée' : 'Brouillon'}</Badge>
                      {l.free_preview && (
                        <Badge tone="violet">
                          <Gift size={11} /> Aperçu gratuit
                        </Badge>
                      )}
                      {l.drip_days > 0 && (
                        <Badge tone="amber">
                          <Clock size={11} /> J+{l.drip_days}
                        </Badge>
                      )}
                      {l.video_url && (
                        <Badge tone="blue">
                          <Video size={11} /> Vidéo
                        </Badge>
                      )}
                      {l.files_count > 0 && (
                        <Badge>
                          <Paperclip size={11} /> {l.files_count}
                        </Badge>
                      )}
                    </span>
                  </Link>
                  <Button size="xs" variant="ghost" onClick={() => toggleLesson(l)}>
                    {l.status === 'published' ? 'Dépublier' : 'Publier'}
                  </Button>
                  <IconButton icon={ArrowUp} label="Monter la leçon" disabled={busy || (li === 0 && mi === 0)} onClick={() => moveLesson(mi, li, -1)} />
                  <IconButton icon={ArrowDown} label="Descendre la leçon" disabled={busy || (li === m.lessons.length - 1 && mi === modules.length - 1)} onClick={() => moveLesson(mi, li, 1)} />
                  <IconButton icon={Trash} label="Supprimer la leçon" className="hover:bg-rose-50 hover:text-rose-600" onClick={() => deleteLesson(l)} />
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-slate-100 px-5 py-3">
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setPrompt({ kind: 'lesson', module: m })}>
              Ajouter une leçon
            </Button>
          </div>
        </Card>
      ))}
      <Button variant="secondary" icon={Plus} onClick={() => setPrompt({ kind: 'module' })}>
        Ajouter un module
      </Button>

      <NamePrompt
        open={!!prompt}
        title={prompt?.kind === 'module' ? 'Nouveau module' : prompt?.kind === 'rename' ? 'Renommer le module' : 'Nouvelle leçon'}
        label={prompt?.kind === 'lesson' ? 'Titre de la leçon' : 'Titre du module'}
        initial={prompt?.kind === 'rename' ? prompt.module.title : ''}
        submitLabel={prompt?.kind === 'rename' ? 'Renommer' : 'Ajouter'}
        onClose={() => setPrompt(null)}
        onSubmit={submitPrompt}
      />
    </div>
  );
}

function NamePrompt({ open, title, label, initial, submitLabel, onClose, onSubmit }: { open: boolean; title: string; label: string; initial: string; submitLabel: string; onClose: () => void; onSubmit: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
        className="space-y-5"
      >
        <Field label={label}>
          <Input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={200} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- students ----------

/** `<input type="date">` value (local day) ↔ ISO instant. */
const toDay = (iso: string | null | undefined) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const fromDay = (day: string, endOfDay = false) => (day ? new Date(`${day}T${endOfDay ? '23:59:59' : '00:00:00'}`).toISOString() : null);

function StudentsTab({ course, onCount }: { course: Course; onCount: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, setData, error, reload } = useLoad(() => coursesApi.students(course.id), [course.id]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [editing, setEditing] = useState<CourseStudent | null>(null);

  const update = (list: CourseStudent[]) => {
    setData(list);
    onCount();
  };

  const remove = async (s: CourseStudent) => {
    const hasTag = s.via.includes('tag');
    const ok = await confirm({
      title: `Retirer l’accès de ${contactName(s.contact)} ?`,
      message: hasTag
        ? 'Son accès manuel est supprimé et le tag d’accès de la formation lui est retiré. Sa progression est conservée.'
        : 'Ce contact ne pourra plus ouvrir les leçons. Sa progression est conservée s’il retrouve un accès.',
      confirmLabel: 'Retirer l’accès',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await coursesApi.removeStudent(course.id, s.contact.id, hasTag);
      toast.success('Accès retiré');
      await reload();
      onCount();
    } catch (e) {
      toast.error(e);
    }
  };

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data) return <PageLoader />;

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {course.access_tag_id ? 'Les contacts ayant le tag d’accès de la formation sont inscrits automatiquement.' : 'Aucun tag d’accès n’est défini (onglet Réglages) : seuls les contacts inscrits manuellement ont accès.'}
        </p>
        <Button icon={UserPlus} onClick={() => setEnrollOpen(true)}>
          Inscrire un contact
        </Button>
      </div>
      {data.length === 0 ? (
        <EmptyState icon={Users} title="Aucun élève pour le moment" description="Inscrivez un contact manuellement, ou attribuez le tag d’accès de la formation (achat, automatisation, formulaire…)." />
      ) : (
        <Card padded={false} className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                <th className="px-5 py-3">Élève</th>
                <th className="px-3 py-3">Accès</th>
                <th className="px-3 py-3">Depuis le</th>
                <th className="px-3 py-3">Expire le</th>
                <th className="px-3 py-3">Progression</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((s) => (
                <tr key={s.contact.id} className={cx(!s.active && 'bg-slate-50/60 text-slate-500')}>
                  <td className="px-5 py-3">
                    <Link to={`/contacts/${s.contact.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {contactName(s.contact)}
                    </Link>
                    <span className="block text-xs text-slate-500">{s.contact.email}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex flex-wrap gap-1">
                      {s.via.includes('tag') && (
                        <Badge tone="violet">
                          <TagIcon size={11} /> Tag
                        </Badge>
                      )}
                      {s.via.includes('manual') && <Badge tone="blue">Manuel</Badge>}
                      {!s.active && <Badge tone="red">Expiré</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-3 whitespace-nowrap">{fmtDate(s.access_at)}</td>
                  <td className="px-3 py-3 whitespace-nowrap">{s.expires_at ? fmtDate(s.expires_at) : '—'}</td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
                        <div className="h-full rounded-full bg-brand-500" style={{ width: `${s.percent}%` }} />
                      </div>
                      <span className="text-xs tabular-nums">
                        {s.percent} % · {s.completed_lessons}/{s.total_lessons}
                      </span>
                      {s.completed_at && (
                        <Badge tone="green">
                          <Check size={11} /> Terminée
                        </Badge>
                      )}
                    </div>
                    {s.last_activity_at && <span className="text-xs text-slate-400">Dernière leçon {fmtRelative(s.last_activity_at)}</span>}
                  </td>
                  <td className="px-5 py-3">
                    <div className="flex justify-end gap-1">
                      <IconButton icon={CalendarClock} label={s.manual ? 'Modifier les dates d’accès' : 'Définir des dates d’accès (accès manuel)'} onClick={() => setEditing(s)} />
                      <IconButton icon={Trash} label="Retirer l’accès" className="hover:bg-rose-50 hover:text-rose-600" onClick={() => remove(s)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      <EnrollModal course={course} open={enrollOpen} student={null} onClose={() => setEnrollOpen(false)} onSaved={update} />
      <EnrollModal course={course} open={!!editing} student={editing} onClose={() => setEditing(null)} onSaved={update} />
    </>
  );
}

/** Manual access: new student (by email) or dates of an existing one. */
function EnrollModal({ course, open, student, onClose, onSaved }: { course: Course; open: boolean; student: CourseStudent | null; onClose: () => void; onSaved: (list: CourseStudent[]) => void }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [accessDay, setAccessDay] = useState('');
  const [expiresDay, setExpiresDay] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setAccessDay(toDay(student?.manual?.access_at ?? student?.access_at ?? new Date().toISOString()));
    setExpiresDay(toDay(student?.manual?.expires_at));
  }, [open, student]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const dates = { access_at: fromDay(accessDay) ?? undefined, expires_at: fromDay(expiresDay, true) };
      onSaved(await coursesApi.enroll(course.id, student ? { contact_id: student.contact.id, ...dates } : { email: email.trim(), ...dates }));
      toast.success(student ? 'Dates d’accès enregistrées' : 'Contact inscrit à la formation');
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={student ? `Accès de ${contactName(student.contact)}` : 'Inscrire un contact'}
      description={student ? undefined : 'Le contact est créé s’il n’existe pas encore. Il se connecte à l’espace membres avec cette adresse email.'}
    >
      <form onSubmit={submit} className="space-y-5">
        {!student && (
          <Field label="Adresse email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="eleve@exemple.fr" />
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Date d’accès" hint="Point de départ de la diffusion progressive.">
            <Input type="date" value={accessDay} onChange={(e) => setAccessDay(e.target.value)} required />
          </Field>
          <Field label="Expiration (facultatif)" hint="Vide : accès sans limite.">
            <Input type="date" value={expiresDay} onChange={(e) => setExpiresDay(e.target.value)} min={accessDay} />
          </Field>
        </div>
        {student && !student.manual && (
          <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">Ce contact a accès par son tag. Enregistrer crée en plus un accès manuel avec ces dates (l’accès le plus favorable s’applique).</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={saving}>
            {student ? 'Enregistrer' : 'Inscrire'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- settings ----------

function SettingsTab({ course, onChange }: { course: Course; onChange: (c: Course) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: tags } = useLoad<Tag[]>(() => api.tags(), []);
  const [form, setForm] = useState({
    title: course.title,
    slug: course.slug,
    description: course.description,
    image_url: course.image_url ?? '',
    access_tag_id: course.access_tag_id ? String(course.access_tag_id) : '',
    access_days: course.access_days ? String(course.access_days) : '',
    purchase_url: course.purchase_url ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await coursesApi.updateCourse(course.id, {
        title: form.title.trim(),
        slug: form.slug.trim(),
        description: form.description,
        image_url: form.image_url.trim() || null,
        access_tag_id: form.access_tag_id ? Number(form.access_tag_id) : null,
        access_days: form.access_days ? Number(form.access_days) : null,
        purchase_url: form.purchase_url.trim() || null,
      });
      onChange(updated);
      toast.success('Réglages enregistrés');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `Supprimer la formation « ${course.title} » ?`,
      message: 'Modules, leçons, fichiers, inscriptions et progression des élèves seront supprimés définitivement.',
      confirmLabel: 'Supprimer la formation',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await coursesApi.deleteCourse(course.id);
      toast.success('Formation supprimée');
      navigate('/courses');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader icon={BookOpen} title="Présentation" description="Affichée dans la bibliothèque des membres et sur la fiche de la formation." />
        <div className="space-y-5">
          <Field label="Titre">
            <Input value={form.title} onChange={(e) => set({ title: e.target.value })} required maxLength={200} />
          </Field>
          <Field label="Description">
            <Textarea rows={5} value={form.description} onChange={(e) => set({ description: e.target.value })} maxLength={5000} placeholder="Ce que vos élèves vont apprendre…" />
          </Field>
          <Field label="Image de couverture" hint="Format 16:9 conseillé.">
            <div className="flex items-center gap-2">
              <Input value={form.image_url} onChange={(e) => set({ image_url: e.target.value })} placeholder="https://… ou choisissez une image" className="flex-1" />
              <Button variant="secondary" icon={ImagePlus} onClick={() => setMediaOpen(true)}>
                Choisir
              </Button>
            </div>
          </Field>
          <Field label="Adresse" hint="Changer l’adresse invalide les liens déjà partagés vers cette formation.">
            <div className="flex items-center gap-2">
              <span className="max-w-[55%] shrink-0 truncate text-sm text-slate-500">{course.url.slice(0, course.url.length - course.slug.length).replace(/^https?:\/\//, '')}</span>
              <Input value={form.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase() })} required maxLength={60} className="flex-1 font-mono" />
              <IconButton icon={Copy} label="Copier le lien de la formation" onClick={async () => (await copyText(course.url)) && toast.success('Lien copié')} />
            </div>
          </Field>
        </div>
      </Card>

      <div className="space-y-6">
        <Card>
          <CardHeader icon={TagIcon} title="Accès" description="Un contact a accès s’il a le tag ci-dessous, ou s’il est inscrit manuellement (onglet Élèves)." />
          <div className="space-y-5">
            <Field label="Tag donnant accès" hint="Attribuez ce tag après un achat, depuis une automatisation, un formulaire ou la fiche du contact. La diffusion progressive démarre à la date d’obtention du tag.">
              <Select value={form.access_tag_id} onChange={(e) => set({ access_tag_id: e.target.value })}>
                <option value="">Aucun (accès manuel uniquement)</option>
                {(tags ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Durée de l’accès par tag (jours)" hint="Vide : accès sans limite. Sinon l’accès expire N jours après l’obtention du tag.">
              <Input type="number" min={1} max={3650} value={form.access_days} onChange={(e) => set({ access_days: e.target.value })} placeholder="Illimitée" className="w-40" />
            </Field>
            <Field label="Lien d’achat" hint="Proposé aux visiteurs et aux contacts sans accès sur la fiche de la formation (page de vente, tunnel…).">
              <Input value={form.purchase_url} onChange={(e) => set({ purchase_url: e.target.value })} placeholder="https://…" />
            </Field>
          </div>
        </Card>
        <div className="flex items-center justify-between gap-3">
          <Button variant="ghost" icon={Trash} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={remove}>
            Supprimer la formation
          </Button>
          <Button type="submit" loading={saving}>
            Enregistrer
          </Button>
        </div>
      </div>

      <MediaLibrary
        open={mediaOpen}
        onClose={() => setMediaOpen(false)}
        onPick={(url) => {
          set({ image_url: url });
          setMediaOpen(false);
        }}
      />
    </form>
  );
}

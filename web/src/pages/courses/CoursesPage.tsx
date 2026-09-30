import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BookOpen, Copy, ExternalLink, Eye, GraduationCap, ImagePlus, Layers, Palette, Plus, Users } from 'lucide-react';
import type { Course, MemberArea } from '@scalo/shared';
import { coursesApi } from '../../lib/courses-api';
import { copyText, useLoad } from '../../lib/hooks';
import { fmtNumber } from '../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, Tabs } from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { MediaLibrary } from '../../builder/MediaLibrary';

type Tab = 'courses' | 'area';

export function CoursesPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'area' ? 'area' : 'courses';
  const { data, error, loading, reload } = useLoad(() => coursesApi.courses(), []);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <>
      <PageHeader
        title="Formations"
        description="Créez vos formations en ligne et donnez-y accès dans votre espace membres."
        actions={
          <Button icon={Plus} onClick={() => setCreateOpen(true)}>
            Nouvelle formation
          </Button>
        }
      />
      <Tabs<Tab>
        className="mb-6"
        value={tab}
        onChange={(t) => setParams(t === 'area' ? { tab: 'area' } : {}, { replace: true })}
        tabs={[
          { id: 'courses', label: 'Formations', icon: GraduationCap, count: data?.length },
          { id: 'area', label: 'Espace membres', icon: Palette },
        ]}
      />

      {tab === 'area' ? (
        <MemberAreaSettings />
      ) : error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <Skeleton className="h-32 w-full" />
              <Skeleton className="mt-4 h-5 w-40" />
              <Skeleton className="mt-2 h-3.5 w-28" />
            </Card>
          ))}
        </div>
      ) : data && data.length === 0 ? (
        <EmptyState
          icon={GraduationCap}
          title="Créez votre première formation"
          description="Organisez vos leçons en modules, ajoutez vidéos et fichiers, puis donnez accès à vos contacts par un tag ou manuellement."
          action={
            <Button icon={Plus} onClick={() => setCreateOpen(true)}>
              Nouvelle formation
            </Button>
          }
        />
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{data?.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      )}

      <CreateCourseModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </>
  );
}

function CourseCard({ c }: { c: Course }) {
  return (
    <Link to={`/courses/${c.id}`} className="group block">
      <Card padded={false} className="h-full overflow-hidden transition-all group-hover:-translate-y-0.5 group-hover:border-brand-200 group-hover:shadow-pop">
        <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-brand-500 to-brand-900 text-white/80">
          {c.image_url ? <img src={c.image_url} alt="" className="h-full w-full object-cover" /> : <GraduationCap size={40} strokeWidth={1.5} />}
        </div>
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <h3 className="min-w-0 truncate font-semibold text-slate-900 group-hover:text-brand-700">{c.title}</h3>
            <Badge tone={c.status === 'published' ? 'green' : 'slate'} dot>
              {c.status === 'published' ? 'Publiée' : 'Brouillon'}
            </Badge>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <Layers size={14} /> {c.modules_count} module{c.modules_count > 1 ? 's' : ''}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <BookOpen size={14} /> {c.lessons_count} leçon{c.lessons_count > 1 ? 's' : ''}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Users size={14} /> {fmtNumber(c.students_count)} élève{c.students_count > 1 ? 's' : ''}
            </span>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function CreateCourseModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setTitle('');
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const c = await coursesApi.createCourse(title.trim());
      toast.success('Formation créée');
      onClose();
      navigate(`/courses/${c.id}`);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Nouvelle formation" description="Elle est créée en brouillon : vos membres ne la voient pas tant qu’elle n’est pas publiée.">
      <form onSubmit={submit} className="space-y-5">
        <Field label="Titre de la formation">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Méthode complète de piano" required maxLength={200} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" loading={saving} disabled={!title.trim()}>
            Créer la formation
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Address and branding of the members area (`/m/<slug>`). */
function MemberAreaSettings() {
  const toast = useToast();
  const { data, setData, error, reload } = useLoad(() => coursesApi.area(), []);
  const [form, setForm] = useState<Pick<MemberArea, 'name' | 'slug' | 'logo_url' | 'color'> | null>(null);
  const [saving, setSaving] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);

  useEffect(() => {
    if (data) setForm({ name: data.name, slug: data.slug, logo_url: data.logo_url, color: data.color });
  }, [data]);

  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data || !form) return <Skeleton className="h-72 w-full" />;

  const dirty = form.name !== data.name || form.slug !== data.slug || (form.logo_url ?? '') !== (data.logo_url ?? '') || form.color.toLowerCase() !== data.color.toLowerCase();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      setData(await coursesApi.saveArea({ ...form, logo_url: form.logo_url || null }));
      toast.success('Espace membres enregistré');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader icon={Palette} title="Réglages de l’espace membres" description="Le nom, le logo et la couleur s’affichent sur toutes les pages vues par vos membres, ainsi que dans l’email de connexion." />
        <form onSubmit={save} className="space-y-5">
          <Field label="Nom de l’espace">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} />
          </Field>
          <Field label="Adresse" hint="Lettres minuscules, chiffres et tirets. Changer l’adresse déconnecte les membres et invalide les liens déjà partagés.">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-sm text-slate-500">{data.url.slice(0, data.url.length - data.slug.length)}</span>
              <Input value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} required maxLength={60} pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" className="flex-1 font-mono" />
            </div>
          </Field>
          <Field label="Logo" hint="Facultatif. Sans logo, le nom de l’espace est affiché.">
            <div className="flex items-center gap-2">
              <Input value={form.logo_url ?? ''} onChange={(e) => setForm({ ...form, logo_url: e.target.value })} placeholder="https://… ou choisissez une image" className="flex-1" />
              <Button variant="secondary" icon={ImagePlus} onClick={() => setMediaOpen(true)}>
                Choisir
              </Button>
            </div>
          </Field>
          <Field label="Couleur de marque" hint="Boutons, barres de progression et liens actifs.">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : '#5B4BFF'}
                onChange={(e) => setForm({ ...form, color: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded-lg border border-slate-200 bg-white p-1"
                aria-label="Couleur de marque"
              />
              <Input value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} maxLength={7} pattern="#[0-9a-fA-F]{6}" className="w-32 font-mono" />
            </div>
          </Field>
          <div className="flex justify-end">
            <Button type="submit" loading={saving} disabled={!dirty}>
              Enregistrer
            </Button>
          </div>
        </form>
      </Card>

      <Card className="h-fit">
        <CardHeader icon={ExternalLink} title="Accès des membres" description="Vos membres se connectent avec leur adresse email : ils reçoivent un lien de connexion à usage unique, sans mot de passe." />
        <Field label="Lien à partager">
          <div className="flex gap-2">
            <Input readOnly value={data.url} className="flex-1 font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="secondary" icon={Copy} onClick={async () => (await copyText(data.url)) && toast.success('Lien copié')}>
              Copier
            </Button>
          </div>
        </Field>
        <p className="mt-3 text-xs text-slate-500">Ajoutez ce lien dans l’email envoyé après un achat (campagne déclenchée par le tag d’accès de la formation).</p>
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="secondary" icon={Eye} onClick={() => window.open(data.preview_url, '_blank')}>
            Aperçu en tant que membre
          </Button>
          <Button variant="ghost" icon={ExternalLink} onClick={() => window.open(data.url, '_blank')}>
            Ouvrir la page de connexion
          </Button>
        </div>
      </Card>

      <MediaLibrary
        open={mediaOpen}
        onClose={() => setMediaOpen(false)}
        onPick={(url) => {
          setForm((f) => (f ? { ...f, logo_url: url } : f));
          setMediaOpen(false);
        }}
      />
    </div>
  );
}

import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Download, FileUp, Plus, Search, Tag as TagIcon, Tags, Trash, Upload, Users, X, Filter, Braces, Save } from 'lucide-react';
import { emptyFilter, type BulkSelection, type Contact, type SegmentFilter, type Tag } from '@scalo/shared';
import { crmApi } from '../../lib/crm-api';
import { useCrmRefs } from '../../lib/crm-refs';
import { countConditions, FilterBuilder, isFilterComplete } from '../../components/FilterBuilder';
import { FieldsTab } from './FieldsTab';
import { SegmentModal, SegmentsTab } from './SegmentsTab';
import { BulkBar } from './BulkBar';
import { api, downloadBlob, type ContactFilter } from '../../lib/api';
import { useDebounced, useLoad } from '../../lib/hooks';
import { contactName, fmtDate, fmtNumber, initials } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PageHeader,
  Pagination,
  Select,
  Skeleton,
  Tabs,
  Textarea,
} from '../../components/ui';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';

const LIMIT = 50;

export function ContactsPage() {
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab');
  const tab = tabParam === 'tags' || tabParam === 'segments' || tabParam === 'fields' ? tabParam : 'contacts';
  const { data: tags, reload: reloadTags } = useLoad(() => api.tags(), []);

  return (
    <>
      <PageHeader title="Contacts" description="Votre liste de contacts, leurs tags et leur historique." />
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(t) => {
          const p = new URLSearchParams(params);
          if (t !== 'contacts') p.set('tab', t);
          else p.delete('tab');
          setParams(p, { replace: true });
        }}
        tabs={[
          { id: 'contacts', label: 'Contacts', icon: Users },
          { id: 'segments', label: 'Segments', icon: Filter },
          { id: 'tags', label: 'Tags', icon: Tags, count: tags?.length },
          { id: 'fields', label: 'Champs personnalisés', icon: Braces },
        ]}
      />
      {tab === 'contacts' ? (
        <ContactsTab tags={tags ?? []} reloadTags={reloadTags} />
      ) : tab === 'segments' ? (
        <SegmentsTab />
      ) : tab === 'fields' ? (
        <FieldsTab />
      ) : (
        <TagsTab tags={tags} reload={reloadTags} />
      )}
    </>
  );
}

/* ---------------- contacts list ---------------- */

const STATUS_FILTERS: { id: ContactFilter | ''; label: string }[] = [
  { id: '', label: 'Tous les statuts' },
  { id: 'confirmed', label: 'Abonnés' },
  { id: 'pending_confirmation', label: 'En attente de confirmation' },
  { id: 'unsubscribed', label: 'Désinscrits' },
  { id: 'bounced', label: 'Adresses invalides (bounce)' },
];

function ContactsTab({ tags, reloadTags }: { tags: Tag[]; reloadTags: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const debounced = useDebounced(search.trim(), 300);
  const tagId = params.get('tag') ? Number(params.get('tag')) : '';
  const statusParam = params.get('status');
  const status: ContactFilter | '' = STATUS_FILTERS.some((f) => f.id === statusParam) ? (statusParam as ContactFilter) : '';
  const [page, setPage] = useState(1);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(params.get('import') === '1');
  const [exporting, setExporting] = useState(false);
  // segment (saved) + ad hoc multi-criteria filter
  const segmentId = params.get('segment') ? Number(params.get('segment')) : '';
  const { refs, reload: reloadRefs } = useCrmRefs();
  const [filter, setFilter] = useState<SegmentFilter>(emptyFilter());
  const [showFilter, setShowFilter] = useState(false);
  const [saveSegment, setSaveSegment] = useState(false);
  const debouncedFilter = useDebounced(JSON.stringify(filter), 400);
  const activeFilter: SegmentFilter | null = (() => {
    const f = JSON.parse(debouncedFilter) as SegmentFilter;
    return f.conditions.length && isFilterComplete(f) ? f : null;
  })();
  const filterKey = activeFilter ? debouncedFilter : '';
  // selection: explicit ids, or every contact matching the current filters
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
    setAllMatching(false);
  }, [debounced, tagId, status, segmentId, filterKey]);

  const { data, error, loading, reload } = useLoad(
    () =>
      activeFilter
        ? crmApi.queryContacts({ search: debounced, tag_id: tagId || null, status: status || null, segment_id: segmentId || null, filter: activeFilter, page, limit: LIMIT })
        : api.contacts({ search: debounced, tag_id: tagId, status, segment_id: segmentId, page, limit: LIMIT }),
    [debounced, tagId, status, segmentId, filterKey, page],
  );

  const setSegment = (v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set('segment', v);
    else p.delete('segment');
    setParams(p, { replace: true });
  };
  const selection: BulkSelection = allMatching
    ? { all: true, search: debounced || undefined, tag_id: tagId || null, status: status || null, segment_id: segmentId || null, filter: activeFilter }
    : { ids: [...selected] };
  const pageIds = data?.items.map((c) => c.id) ?? [];
  const pageChecked = pageIds.length > 0 && pageIds.every((id) => allMatching || selected.has(id));
  const togglePage = () => {
    setAllMatching(false);
    const next = new Set(selected);
    if (pageChecked) pageIds.forEach((id) => next.delete(id));
    else pageIds.forEach((id) => next.add(id));
    setSelected(next);
  };
  const toggleOne = (id: number) => {
    if (allMatching) {
      // leaving "all matching": keep the current page minus this one
      setAllMatching(false);
      setSelected(new Set(pageIds.filter((x) => x !== id)));
      return;
    }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const setStatus = (v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set('status', v);
    else p.delete('status');
    setParams(p, { replace: true });
  };

  const setTag = (v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set('tag', v);
    else p.delete('tag');
    setParams(p, { replace: true });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await api.exportContacts();
      downloadBlob(blob, `contacts-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      toast.error(e);
    } finally {
      setExporting(false);
    }
  };

  const filtered = !!debounced || tagId !== '' || status !== '' || segmentId !== '' || !!activeFilter;
  const nConditions = countConditions(filter);

  return (
    <>
      {/* row 1: search + actions · row 2: filters */}
      <div className="mb-4 space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Input icon={Search} className="min-w-0 sm:max-w-md sm:flex-1" placeholder="Rechercher par nom ou email…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button variant="secondary" icon={Download} onClick={exportCsv} loading={exporting}>
              Exporter
            </Button>
            <Button variant="secondary" icon={Upload} onClick={() => setImportOpen(true)}>
              Importer
            </Button>
            <Button variant="secondary" onClick={() => navigate('/migrate')}>
              Migrer depuis un autre outil
            </Button>
            <Button icon={Plus} onClick={() => setAddOpen(true)}>
              Ajouter un contact
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <Select className="sm:w-48" value={tagId} onChange={(e) => setTag(e.target.value)}>
            <option value="">Tous les tags</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.contacts_count !== undefined ? ` (${t.contacts_count})` : ''}
              </option>
            ))}
          </Select>
          <Select className="sm:w-52" value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </Select>
          <Select className="sm:w-48" value={segmentId} onChange={(e) => setSegment(e.target.value)} aria-label="Segment">
            <option value="">Tous les segments</option>
            {refs.segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button variant={showFilter || nConditions ? 'dark' : 'secondary'} icon={Filter} onClick={() => setShowFilter((v) => !v)}>
            Filtres{nConditions ? ` (${nConditions})` : ''}
          </Button>
        </div>
      </div>

      {showFilter && (
        <Card className="mb-4">
          <FilterBuilder value={filter} onChange={setFilter} refs={refs} />
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-3">
            {nConditions > 0 && !isFilterComplete(filter) && <span className="mr-auto text-xs text-amber-700">Complétez les conditions pour appliquer le filtre.</span>}
            <Button size="sm" variant="ghost" icon={X} onClick={() => setFilter(emptyFilter())} disabled={!nConditions}>
              Effacer
            </Button>
            <Button size="sm" variant="secondary" icon={Save} onClick={() => setSaveSegment(true)} disabled={!activeFilter}>
              Enregistrer comme segment
            </Button>
          </div>
        </Card>
      )}

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !loading && data && data.total === 0 && !filtered ? (
        <EmptyState
          icon={Users}
          title="Aucun contact pour l’instant"
          description="Ajoutez vos premiers contacts manuellement, importez un fichier CSV, ou publiez une page de capture."
          action={
            <div className="flex gap-2">
              <Button variant="secondary" icon={Upload} onClick={() => setImportOpen(true)}>
                Importer un CSV
              </Button>
              <Button icon={Plus} onClick={() => setAddOpen(true)}>
                Ajouter un contact
              </Button>
            </div>
          }
        />
      ) : (
        <Card padded={false} className="overflow-hidden">
          {(selected.size > 0 || allMatching) && data && (
            <BulkBar
              selectedCount={selected.size}
              total={data.total}
              allMatching={allMatching}
              onSelectAll={() => setAllMatching(true)}
              onClear={() => {
                setSelected(new Set());
                setAllMatching(false);
              }}
              selection={selection}
              refs={refs}
              onDone={() => {
                setSelected(new Set());
                setAllMatching(false);
                reload();
                reloadTags();
                reloadRefs();
              }}
            />
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-left text-xs font-medium text-slate-500">
                  <th className="w-10 py-3 pr-0 pl-4">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600"
                      checked={pageChecked}
                      onChange={togglePage}
                      aria-label="Sélectionner les contacts de la page"
                      disabled={!pageIds.length}
                    />
                  </th>
                  <th className="px-4 py-3">Contact</th>
                  <th className="px-4 py-3">Tags</th>
                  <th className="px-4 py-3">Statut</th>
                  <th className="px-4 py-3 text-right">Ajouté le</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading && !data
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i}>
                        <td className="py-3 pr-0 pl-4" />
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <Skeleton className="h-9 w-9 rounded-full" />
                            <div>
                              <Skeleton className="h-3.5 w-32" />
                              <Skeleton className="mt-1.5 h-3 w-44" />
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3"><Skeleton className="h-5 w-24 rounded-full" /></td>
                        <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
                        <td className="px-4 py-3"><Skeleton className="ml-auto h-3.5 w-20" /></td>
                      </tr>
                    ))
                  : data?.items.map((c) => (
                      <ContactRow key={c.id} c={c} onClick={() => navigate(`/contacts/${c.id}`)} checked={allMatching || selected.has(c.id)} onCheck={() => toggleOne(c.id)} />
                    ))}
                {data && data.items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-slate-500">
                      Aucun contact ne correspond à votre recherche.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {data && <Pagination page={page} total={data.total} limit={LIMIT} onChange={setPage} />}
        </Card>
      )}

      <AddContactModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        tags={tags}
        onCreated={(c) => {
          setAddOpen(false);
          toast.success('Contact ajouté');
          reload();
          reloadTags();
          navigate(`/contacts/${c.id}`);
        }}
      />
      <ImportModal
        open={importOpen}
        tags={tags}
        onClose={() => {
          setImportOpen(false);
          if (params.get('import')) {
            const p = new URLSearchParams(params);
            p.delete('import');
            setParams(p, { replace: true });
          }
        }}
        onDone={() => {
          reload();
          reloadTags();
        }}
      />
      <SegmentModal
        segment={saveSegment ? 'new' : null}
        refs={refs}
        initialFilter={activeFilter ?? undefined}
        onClose={() => setSaveSegment(false)}
        onSaved={(s) => {
          setSaveSegment(false);
          toast.success(`Segment « ${s.name} » enregistré`);
          reloadRefs();
          setFilter(emptyFilter());
          setShowFilter(false);
          setSegment(String(s.id));
        }}
      />
    </>
  );
}

function ContactRow({ c, onClick, checked, onCheck }: { c: Contact; onClick: () => void; checked: boolean; onCheck: () => void }) {
  const name = contactName(c);
  const hasName = name !== c.email;
  return (
    <tr onClick={onClick} className={`cursor-pointer transition-colors hover:bg-slate-50${checked ? ' bg-brand-50/40' : ''}`}>
      <td className="w-10 py-3 pr-0 pl-4" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-600" checked={checked} onChange={onCheck} aria-label={`Sélectionner ${c.email}`} />
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <Avatar text={initials(name)} seed={c.email} />
          <div className="min-w-0">
            <p className="truncate font-medium text-slate-900">{hasName ? name : c.email}</p>
            {hasName && <p className="truncate text-xs text-slate-500">{c.email}</p>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex max-w-xs flex-wrap gap-1">
          {c.tags.length === 0 && <span className="text-xs text-slate-400">—</span>}
          {c.tags.slice(0, 3).map((t) => (
            <Badge key={t.id} tone="brand">
              {t.name}
            </Badge>
          ))}
          {c.tags.length > 3 && <Badge>+{c.tags.length - 3}</Badge>}
        </div>
      </td>
      <td className="px-4 py-3">
        {c.bounced ? (
          <Badge tone="red" dot>
            Bounce
          </Badge>
        ) : c.unsubscribed ? (
          <Badge tone="red" dot>
            {c.complained ? 'Plainte spam' : 'Désinscrit'}
          </Badge>
        ) : c.status === 'pending_confirmation' ? (
          <span title="Double opt-in : le contact n’a pas encore cliqué sur le lien de confirmation. Il ne reçoit ni newsletters ni campagnes.">
            <Badge tone="amber" dot>
              En attente de confirmation
            </Badge>
          </span>
        ) : (
          <Badge tone="green" dot>
            Abonné
          </Badge>
        )}
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap text-slate-500">{fmtDate(c.created_at)}</td>
    </tr>
  );
}

function TagInput({ value, onChange, tags }: { value: string[]; onChange: (v: string[]) => void; tags: Tag[] }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setDraft('');
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-2 py-1.5 focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700">
          {t}
          <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} className="text-brand-400 hover:text-brand-700">
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        list="all-tags"
        className="h-7 min-w-24 flex-1 border-0 bg-transparent px-1 text-sm outline-none"
        placeholder={value.length ? '' : 'Tapez puis Entrée…'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
      <datalist id="all-tags">
        {tags.map((t) => (
          <option key={t.id} value={t.name} />
        ))}
      </datalist>
    </div>
  );
}

function AddContactModal({ open, onClose, onCreated, tags }: { open: boolean; onClose: () => void; onCreated: (c: Contact) => void; tags: Tag[] }) {
  const toast = useToast();
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', phone: '' });
  const [tagList, setTagList] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setForm({ email: '', first_name: '', last_name: '', phone: '' });
      setTagList([]);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const c = await api.createContact({
        email: form.email.trim(),
        first_name: form.first_name.trim() || undefined,
        last_name: form.last_name.trim() || undefined,
        phone: form.phone.trim() || undefined,
        tags: tagList.length ? tagList : undefined,
      });
      onCreated(c);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const f = (k: keyof typeof form) => ({ value: form[k], onChange: (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ajouter un contact"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="add-contact" loading={saving}>
            Ajouter
          </Button>
        </>
      }
    >
      <form id="add-contact" onSubmit={submit} className="space-y-4">
        <Field label="Email *">
          <Input type="email" required placeholder="marie@exemple.com" {...f('email')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Prénom">
            <Input placeholder="Marie" {...f('first_name')} />
          </Field>
          <Field label="Nom">
            <Input placeholder="Dupont" {...f('last_name')} />
          </Field>
        </div>
        <Field label="Téléphone">
          <Input type="tel" placeholder="06 12 34 56 78" {...f('phone')} />
        </Field>
        <Field label="Tags" hint="Les tags inexistants seront créés.">
          <TagInput value={tagList} onChange={setTagList} tags={tags} />
        </Field>
      </form>
    </Modal>
  );
}

function ImportModal({ open, onClose, onDone, tags }: { open: boolean; onClose: () => void; onDone: () => void; tags: Tag[] }) {
  const toast = useToast();
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [tag, setTag] = useState('');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setCsv('');
      setFileName(null);
      setTag('');
      setResult(null);
    }
  }, [open]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setCsv(await file.text());
    setFileName(file.name);
  };

  const lines = csv.trim() ? csv.trim().split(/\r?\n/).length - 1 : 0;

  const submit = async () => {
    setSaving(true);
    try {
      const r = await api.importContacts({ csv, tag: tag.trim() || undefined });
      setResult(r);
      onDone();
      toast.success(`Import terminé : ${r.created} créé(s), ${r.updated} mis à jour`);
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
      size="lg"
      title="Importer des contacts"
      description="Fichier CSV avec une ligne d’en-tête. Colonne email obligatoire ; first_name/prenom, last_name/nom, phone/telephone facultatives ; les autres colonnes sont associées à vos champs personnalisés par clé ou par libellé. Séparateur , ou ;"
      footer={
        result ? (
          <Button onClick={onClose}>Terminer</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={onClose}>
              Annuler
            </Button>
            <Button icon={Upload} onClick={submit} loading={saving} disabled={!csv.trim()}>
              Importer{lines > 0 ? ` ${fmtNumber(lines)} ligne${lines > 1 ? 's' : ''}` : ''}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="grid grid-cols-3 gap-3 text-center">
          {[
            ['Créés', result.created, 'text-emerald-600 bg-emerald-50'],
            ['Mis à jour', result.updated, 'text-brand-600 bg-brand-50'],
            ['Ignorés', result.skipped, 'text-slate-600 bg-slate-100'],
          ].map(([l, v, c]) => (
            <div key={l as string} className={`rounded-xl p-4 ${c}`}>
              <p className="text-3xl font-bold">{fmtNumber(v as number)}</p>
              <p className="mt-1 text-sm font-medium">{l}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              onFile(e.dataTransfer.files[0]);
            }}
            className="flex w-full flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-300 px-6 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40"
          >
            <FileUp size={28} className="mb-2 text-brand-500" />
            <span className="text-sm font-semibold text-slate-800">{fileName ?? 'Choisir un fichier CSV'}</span>
            <span className="mt-1 text-xs text-slate-500">ou glissez-le ici — vous pouvez aussi coller le contenu ci-dessous</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <Field label="Contenu CSV">
            <Textarea
              rows={7}
              className="font-mono text-xs"
              value={csv}
              onChange={(e) => {
                setCsv(e.target.value);
                setFileName(null);
              }}
              placeholder={'email,prenom,nom\nmarie@exemple.com,Marie,Dupont\njean@exemple.com,Jean,Martin'}
            />
          </Field>
          <Field label="Ajouter un tag aux contacts importés (facultatif)">
            <Input list="import-tags" icon={TagIcon} value={tag} onChange={(e) => setTag(e.target.value)} placeholder="ex. webinar-mars" />
            <datalist id="import-tags">
              {tags.map((t) => (
                <option key={t.id} value={t.name} />
              ))}
            </datalist>
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- tags tab ---------------- */

function TagsTab({ tags, reload }: { tags: Tag[] | undefined; reload: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.createTag(name.trim());
      setName('');
      reload();
      toast.success('Tag créé');
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (t: Tag) => {
    const ok = await confirm({
      title: `Supprimer le tag « ${t.name} » ?`,
      message: `Il sera retiré de ${fmtNumber(t.contacts_count ?? 0)} contact(s). Les contacts eux-mêmes ne sont pas supprimés.`,
      confirmLabel: 'Supprimer',
    });
    if (!ok) return;
    try {
      await api.deleteTag(t.id);
      reload();
      toast.success('Tag supprimé');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card className="h-fit">
        <h3 className="text-base font-semibold text-slate-900">Nouveau tag</h3>
        <p className="mt-1 text-sm text-slate-500">Les tags servent à segmenter vos contacts et à déclencher des campagnes.</p>
        <form onSubmit={create} className="mt-4 flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex. client" className="flex-1" />
          <Button type="submit" icon={Plus} loading={saving} disabled={!name.trim()}>
            Créer
          </Button>
        </form>
      </Card>
      <Card padded={false} className="overflow-hidden lg:col-span-2">
        {!tags ? (
          <div className="space-y-3 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : tags.length === 0 ? (
          <EmptyState icon={Tags} title="Aucun tag" description="Créez votre premier tag pour organiser vos contacts." className="m-5 border-0" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {tags.map((t) => (
              <li key={t.id} className="group flex items-center gap-3 px-5 py-3 hover:bg-slate-50">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-50 text-brand-600">
                  <TagIcon size={15} />
                </span>
                <button className="min-w-0 flex-1 text-left" onClick={() => navigate(`/contacts?tag=${t.id}`)}>
                  <span className="block truncate text-sm font-medium text-slate-900 hover:text-brand-700">{t.name}</span>
                </button>
                <Badge tone="slate">
                  {fmtNumber(t.contacts_count ?? 0)} contact{(t.contacts_count ?? 0) > 1 ? 's' : ''}
                </Badge>
                <button onClick={() => remove(t)} className="rounded-lg p-1.5 text-slate-400 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-600" title="Supprimer">
                  <Trash size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

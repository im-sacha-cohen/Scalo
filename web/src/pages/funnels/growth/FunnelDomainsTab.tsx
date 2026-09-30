// Funnel → "Domaines": custom domains serving the funnel, DNS records to create, verification status.
import { useState, type FormEvent } from 'react';
import { CircleCheck, CircleX, Clock, Copy, ExternalLink, Globe, Plus, RefreshCw, Trash } from 'lucide-react';
import type { CustomDomain, Funnel } from '@scalo/shared';
import { growthApi } from '../../../lib/growth-api';
import { copyText, useLoad } from '../../../lib/hooks';
import { fmtDateTime } from '../../../lib/format';
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, Field, Input, Select, Skeleton } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';

const STATUS = {
  pending: { label: 'En attente', tone: 'amber' as const, icon: Clock },
  verified: { label: 'Vérifié', tone: 'green' as const, icon: CircleCheck },
  error: { label: 'Erreur', tone: 'red' as const, icon: CircleX },
};

function Copyable({ value }: { value: string }) {
  const toast = useToast();
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-xs text-slate-800 ring-1 ring-slate-200" title={value}>
        {value}
      </code>
      <button
        type="button"
        className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-800"
        title="Copier"
        aria-label={`Copier ${value}`}
        onClick={async () => {
          if (await copyText(value)) toast.success('Copié');
        }}
      >
        <Copy size={14} />
      </button>
    </span>
  );
}

export function FunnelDomainsTab({ funnel }: { funnel: Funnel }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, setData, error, loading, reload } = useLoad(() => growthApi.domains(funnel.id), [funnel.id]);
  const [domain, setDomain] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const steps = funnel.steps ?? [];

  const replace = (d: CustomDomain) => setData((data ?? []).map((x) => (x.id === d.id ? d : x)));

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      const d = await growthApi.addDomain(funnel.id, { domain: domain.trim() });
      setData([...(data ?? []), d]);
      setDomain('');
      toast.success('Domaine ajouté : créez maintenant l’enregistrement DNS');
    } catch (err) {
      toast.error(err);
    } finally {
      setAdding(false);
    }
  };

  const verify = async (d: CustomDomain) => {
    setBusy(d.id);
    try {
      const v = await growthApi.verifyDomain(d.id);
      replace(v);
      if (v.status === 'verified') toast.success(`${v.domain} est vérifié`);
      else toast.error(v.last_error ?? 'Vérification impossible');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: CustomDomain) => {
    const ok = await confirm({
      title: `Retirer ${d.domain} ?`,
      message: 'Le tunnel ne sera plus accessible à cette adresse. Pensez à supprimer aussi l’enregistrement DNS.',
      confirmLabel: 'Retirer le domaine',
    });
    if (!ok) return;
    try {
      await growthApi.deleteDomain(d.id);
      setData((data ?? []).filter((x) => x.id !== d.id));
      toast.success('Domaine retiré');
    } catch (err) {
      toast.error(err);
    }
  };

  const setRoot = async (d: CustomDomain, v: string) => {
    try {
      replace(await growthApi.updateDomain(d.id, { root_step_id: v ? Number(v) : null }));
      toast.success('Page d’accueil du domaine mise à jour');
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          icon={Globe}
          title="Domaine personnalisé"
          description="Publiez ce tunnel sur votre propre adresse (ex. offre.mondomaine.fr) au lieu du lien /p/… — qui continue de fonctionner."
        />
        <form onSubmit={add} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Nom de domaine" className="flex-1">
            <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="offre.mondomaine.fr" autoComplete="off" spellCheck={false} required />
          </Field>
          <Button type="submit" icon={Plus} loading={adding} disabled={!domain.trim()}>
            Ajouter le domaine
          </Button>
        </form>
      </Card>

      {error && !data ? (
        <ErrorState message={error} onRetry={reload} />
      ) : loading && !data ? (
        <Skeleton className="h-40 w-full" />
      ) : !data?.length ? (
        <EmptyState icon={Globe} title="Aucun domaine" description="Ajoutez un domaine, créez l’enregistrement DNS indiqué chez votre registraire, puis cliquez sur « Vérifier »." />
      ) : (
        data.map((d) => {
          const s = STATUS[d.status];
          return (
            <Card key={d.id}>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-slate-900">{d.domain}</h3>
                    <Badge tone={s.tone}>
                      <s.icon size={12} /> {s.label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {d.status === 'verified' && d.verified_at ? `Vérifié le ${fmtDateTime(d.verified_at)}` : 'Pas encore vérifié'}
                    {d.last_checked_at && ` · dernière vérification ${fmtDateTime(d.last_checked_at)}`}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {d.status === 'verified' && (
                    <Button variant="secondary" size="sm" icon={ExternalLink} onClick={() => window.open(d.url, '_blank', 'noopener')}>
                      Ouvrir
                    </Button>
                  )}
                  <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === d.id} onClick={() => verify(d)}>
                    Vérifier
                  </Button>
                  <Button variant="ghost" size="sm" icon={Trash} className="text-rose-600 hover:bg-rose-50 hover:text-rose-700" onClick={() => remove(d)}>
                    Retirer
                  </Button>
                </div>
              </div>

              {d.last_error && (
                <p role="alert" className={`mt-3 rounded-lg px-3 py-2 text-sm ${d.status === 'verified' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'}`}>
                  {d.last_error}
                </p>
              )}

              {d.status !== 'verified' && (
                <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <p className="mb-2 text-xs font-semibold text-slate-700">Enregistrements DNS à créer chez votre registraire (un seul suffit)</p>
                  <div className="space-y-3">
                    {d.records.map((r) => (
                      <div key={r.type} className="grid gap-1.5 sm:grid-cols-[70px_1fr_1fr]">
                        <span className="text-xs font-bold text-slate-600">{r.type}</span>
                        <Copyable value={r.host} />
                        <Copyable value={r.value} />
                        <span className="text-[11px] text-slate-500 sm:col-span-3 sm:col-start-2">{r.purpose}</span>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-[11px] text-slate-500">
                    Domaine racine (sans « www ») : un CNAME n’y est pas possible chez la plupart des registraires — utilisez un enregistrement ALIAS / ANAME ou A vers votre serveur,
                    et le TXT pour la vérification. La propagation DNS peut prendre jusqu’à 24 h.
                  </p>
                </div>
              )}

              <Field label="Page affichée à la racine du domaine" hint="Les autres étapes restent accessibles à leur adresse (ex. /merci)." className="mt-4 max-w-sm">
                <Select value={d.root_step_id ?? ''} onChange={(e) => setRoot(d, e.target.value)}>
                  <option value="">Première étape du tunnel</option>
                  {steps.map((st) => (
                    <option key={st.id} value={st.id}>
                      {st.name} (/{st.slug})
                    </option>
                  ))}
                </Select>
              </Field>
            </Card>
          );
        })
      )}
    </div>
  );
}

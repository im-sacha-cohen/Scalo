// Settings → IA: the account's Anthropic API key ("bring your own key") and the usage log.
import { useState, type FormEvent } from 'react';
import { Activity, KeyRound, Sparkles } from 'lucide-react';
import { Badge, Button, Card, CardHeader, ErrorState, Field, Input, PageLoader } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useLoad } from '../../lib/hooks';
import { fmtDateTime, fmtNumber } from '../../lib/format';
import { AI_KIND_LABELS, aiApi, type AiGeneration } from '../../lib/ai-api';

const STATUS: Record<AiGeneration['status'], { label: string; tone: 'green' | 'red' | 'blue' }> = {
  done: { label: 'Terminé', tone: 'green' },
  failed: { label: 'Échec', tone: 'red' },
  running: { label: 'En cours', tone: 'blue' },
};

export function AiSettings() {
  const toast = useToast();
  const status = useLoad(() => aiApi.status(), []);
  const usage = useLoad(() => aiApi.usage(), []);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  if (status.loading && !status.data) return <PageLoader />;
  if (status.error && !status.data) return <ErrorState message={status.error} onRetry={status.reload} />;
  const s = status.data!;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      status.setData(await aiApi.saveKey(key.trim()));
      setKey('');
      toast.success('Clé API enregistrée');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      status.setData(await aiApi.deleteKey());
      toast.success('Clé API supprimée');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          icon={Sparkles}
          title="Intelligence artificielle"
          description="Générez des tunnels, des séquences d’emails et des newsletters, et réécrivez vos textes avec Claude (Anthropic)."
          actions={s.configured ? <Badge tone="green" dot>Activée</Badge> : <Badge tone="amber" dot>Clé requise</Badge>}
        />
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            Scalo utilise <strong>votre propre clé API</strong> : créez-la sur <span className="font-mono text-[13px]">console.anthropic.com</span> (API keys). Les générations sont
            facturées par Anthropic selon votre usage ; la clé est chiffrée sur le serveur et n’est plus jamais affichée.
          </p>
          {s.source === 'account' && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <p className="flex items-center gap-2">
                <KeyRound size={15} className="text-slate-400" />
                <span>
                  Clé enregistrée : <span className="font-mono text-[13px]">sk-ant-…{s.key_hint}</span>
                  {s.key_updated_at && <span className="text-slate-500"> · depuis le {fmtDateTime(s.key_updated_at)}</span>}
                </span>
              </p>
              <Button variant="secondary" size="sm" onClick={remove} loading={busy}>
                Supprimer
              </Button>
            </div>
          )}
          {s.source === 'instance' && (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              Une clé est configurée pour toute l’instance (<span className="font-mono text-[13px]">ANTHROPIC_API_KEY</span>) : l’IA fonctionne déjà. Vous pouvez enregistrer votre propre clé,
              elle sera utilisée à la place.
            </p>
          )}
          <form onSubmit={save} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label={s.source === 'account' ? 'Remplacer la clé' : 'Clé API Anthropic'} className="flex-1">
              <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" spellCheck={false} />
            </Field>
            <Button type="submit" loading={busy} disabled={!key.trim()}>
              Enregistrer
            </Button>
          </form>
          <p className="text-xs text-slate-500">
            Modèle : <span className="font-mono">{s.model}</span> · Limite : {s.rate_limit.max} générations par {s.rate_limit.window_minutes >= 60 ? 'heure' : `${s.rate_limit.window_minutes} min`} et par compte.
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader icon={Activity} title="Journal d’usage" description="Les 50 dernières générations et les jetons consommés (entrée / sortie)." />
        {usage.error && !usage.data ? (
          <ErrorState message={usage.error} onRetry={usage.reload} />
        ) : !usage.data ? (
          <p className="text-sm text-slate-500">Chargement…</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-3 gap-3 text-center">
              {[
                ['Générations (30 j)', usage.data.last_30_days.calls],
                ['Jetons en entrée', usage.data.last_30_days.input_tokens],
                ['Jetons en sortie', usage.data.last_30_days.output_tokens],
              ].map(([label, n]) => (
                <div key={label} className="rounded-xl bg-slate-50 px-3 py-3">
                  <p className="text-lg font-bold text-ink">{fmtNumber(n as number)}</p>
                  <p className="text-xs text-slate-500">{label}</p>
                </div>
              ))}
            </div>
            {usage.data.items.length === 0 ? (
              <p className="text-sm text-slate-500">Aucune génération pour le moment.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-left text-[13px]">
                  <thead className="bg-slate-50 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 font-medium">Date</th>
                      <th className="px-3 py-2 font-medium">Type</th>
                      <th className="px-3 py-2 font-medium">Demande</th>
                      <th className="px-3 py-2 font-medium">État</th>
                      <th className="px-3 py-2 text-right font-medium">Jetons</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {usage.data.items.map((g) => (
                      <tr key={g.id}>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDateTime(g.created_at)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-800">{AI_KIND_LABELS[g.kind]}</td>
                        <td className="max-w-56 truncate px-3 py-2 text-slate-600" title={g.error ?? g.label}>
                          {g.error ?? g.label}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={STATUS[g.status].tone}>{STATUS[g.status].label}</Badge>
                        </td>
                        <td className="px-3 py-2 text-right font-mono whitespace-nowrap text-slate-600">
                          {fmtNumber(g.input_tokens)} / {fmtNumber(g.output_tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

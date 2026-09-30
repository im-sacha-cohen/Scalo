// Step panel → "Test A/B": variants of the page, split, results per arm, pause, declare the winner.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Copy, Eye, FlaskConical, Pause, Pencil, Play, Plus, Trash, Trophy } from 'lucide-react';
import type { AbArmStats, Funnel, Step, StepAbTest } from '@scalo/shared';
import { growthApi } from '../../../lib/growth-api';
import { useLoad } from '../../../lib/hooks';
import { fmtNumber, fmtPercent } from '../../../lib/format';
import { Badge, Button, Card, IconButton, Input, Skeleton, Tip, cx } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';

const STATUS_LABEL = { off: 'Aucun test en cours', running: 'Test en cours', paused: 'En pause' } as const;

function Verdict({ arm }: { arm: AbArmStats }) {
  if (arm.variant_id === 0) return <span className="text-xs text-slate-400">Référence</span>;
  if (arm.significant) {
    return (
      <Tip label={`Test z à 2 proportions, p = ${arm.p_value?.toFixed(3)} (seuil 0,05)`}>
        <Badge tone={(arm.lift ?? 0) > 0 ? 'green' : 'red'}>{(arm.lift ?? 0) > 0 ? 'Meilleure (95 %)' : 'Moins bonne (95 %)'}</Badge>
      </Tip>
    );
  }
  return (
    <Tip label="Moins de 100 visiteurs par version ou de 10 inscriptions au total, ou écart pas encore significatif : attendez avant de conclure.">
      <span className="text-xs text-slate-500">Pas encore concluant</span>
    </Tip>
  );
}

export function StepAbCard({ funnel, step, onChanged }: { funnel: Funnel; step: Step; onChanged?: (status: StepAbTest['status'], count: number) => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data, setData, loading } = useLoad(() => growthApi.abTest(step.id), [step.id]);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = (t: StepAbTest) => {
    setData(t);
    onChanged?.(t.status, t.variants.length);
  };
  const run = async (key: string, fn: () => Promise<StepAbTest | void>, success?: string) => {
    setBusy(key);
    try {
      const t = await fn();
      apply(t ?? (await growthApi.abTest(step.id)));
      if (success) toast.success(success);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const editUrl = (variantId: number) => `/funnels/${funnel.id}/steps/${step.id}/edit${variantId ? `?variant=${variantId}` : ''}`;
  const preview = (variantId: number) => {
    const base = step.preview_url || `/p/${funnel.slug}/${step.slug}?preview=1`;
    window.open(`${base}${base.includes('?') ? '&' : '?'}variant=${variantId}`, '_blank');
  };

  if (loading && !data) return <Skeleton className="mt-5 h-24 w-full" />;
  if (!data) return null;
  const hasVariants = data.variants.length > 0;
  const activeVariants = data.variants.filter((v) => v.active).length;

  return (
    <Card className="mt-5 border-slate-200 bg-slate-50/40">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-violet-100 text-violet-600">
            <FlaskConical size={15} />
          </span>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold text-slate-900">Test A/B</h3>
              <Badge tone={data.status === 'running' ? 'green' : data.status === 'paused' ? 'amber' : 'slate'} dot={data.status === 'running'}>
                {STATUS_LABEL[data.status]}
              </Badge>
            </div>
            <p className="mt-0.5 text-sm text-slate-500">
              Comparez des versions de cette page : chaque visiteur voit toujours la même version, et ses inscriptions lui sont attribuées.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon={Plus} disabled={data.variants.length >= 4} loading={busy === 'add'} onClick={() => run('add', async () => void (await growthApi.createVariant(step.id)), 'Variante créée à partir de la page actuelle')}>
            Nouvelle variante
          </Button>
          {data.status === 'running' ? (
            <Button size="sm" variant="secondary" icon={Pause} loading={busy === 'status'} onClick={() => run('status', () => growthApi.updateAbTest(step.id, { status: 'paused' }), 'Test mis en pause : tout le monde voit l’original')}>
              Mettre en pause
            </Button>
          ) : (
            hasVariants && (
              <Button
                size="sm"
                icon={Play}
                disabled={!activeVariants}
                loading={busy === 'status'}
                onClick={() => run('status', () => growthApi.updateAbTest(step.id, { status: 'running' }), data.status === 'paused' ? 'Test repris' : 'Test lancé')}
              >
                {data.status === 'paused' ? 'Reprendre' : 'Lancer le test'}
              </Button>
            )
          )}
        </div>
      </div>

      {hasVariants && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs font-medium text-slate-500">
              <tr>
                <th className="px-3 py-2">Version</th>
                <th className="px-3 py-2">Trafic</th>
                <th className="px-3 py-2 text-right">Visiteurs</th>
                <th className="px-3 py-2 text-right">Optins</th>
                <th className="px-3 py-2 text-right">Conversion</th>
                <th className="px-3 py-2 text-right">Écart</th>
                <th className="px-3 py-2">Résultat</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.arms.map((a) => {
                const v = data.variants.find((x) => x.id === a.variant_id);
                return (
                  <tr key={a.variant_id} className={cx(!a.active && 'text-slate-400')}>
                    <td className="px-3 py-2 font-medium text-slate-800">
                      {a.name}
                      {!a.active && <span className="ml-1.5 text-xs font-normal text-slate-400">(inactive)</span>}
                    </td>
                    <td className="px-3 py-2">
                      <WeightInput
                        key={a.weight}
                        value={a.weight}
                        onSave={(w) =>
                          run('weight', () =>
                            a.variant_id === 0 ? growthApi.updateAbTest(step.id, { control_weight: w }) : growthApi.updateVariant(a.variant_id, { weight: w }).then(() => undefined),
                          )
                        }
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNumber(a.visitors)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtNumber(a.optins)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{fmtPercent(a.rate)}</td>
                    <td className={cx('px-3 py-2 text-right tabular-nums', (a.lift ?? 0) > 0 ? 'text-emerald-600' : (a.lift ?? 0) < 0 ? 'text-rose-600' : '')}>
                      {a.lift === null ? '—' : `${a.lift > 0 ? '+' : ''}${fmtPercent(a.lift)}`}
                    </td>
                    <td className="px-3 py-2">
                      <Verdict arm={a} />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-0.5">
                        <IconButton icon={Pencil} label="Modifier dans l’éditeur" size={14} onClick={() => navigate(editUrl(a.variant_id))} />
                        <IconButton icon={Eye} label="Aperçu de cette version" size={14} onClick={() => preview(a.variant_id)} />
                        {v && (
                          <IconButton
                            icon={Copy}
                            label="Dupliquer"
                            size={14}
                            disabled={data.variants.length >= 4}
                            onClick={() => run('dup', async () => void (await growthApi.createVariant(step.id, { name: `${v.name} (copie)`, from_variant_id: v.id })), 'Variante dupliquée')}
                          />
                        )}
                        {v && (
                          <IconButton
                            icon={FlaskConical}
                            label={v.active ? 'Désactiver (exclure du test)' : 'Réactiver'}
                            size={14}
                            active={!v.active}
                            onClick={() => run('active', async () => void (await growthApi.updateVariant(v.id, { active: !v.active })))}
                          />
                        )}
                        <IconButton
                          icon={Trophy}
                          label="Déclarer gagnante"
                          size={14}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Déclarer « ${a.name} » gagnante ?`,
                              message:
                                a.variant_id === 0
                                  ? 'La page reste inchangée et le test se termine (les variantes sont désactivées).'
                                  : 'Son contenu remplace celui de la page et le test se termine (les variantes sont désactivées).',
                              confirmLabel: 'Déclarer gagnante',
                            });
                            if (ok) run('win', () => growthApi.declareWinner(step.id, a.variant_id), 'Test terminé');
                          }}
                        />
                        {v && (
                          <IconButton
                            icon={Trash}
                            label="Supprimer la variante"
                            size={14}
                            className="hover:text-rose-600"
                            onClick={async () => {
                              const ok = await confirm({ title: `Supprimer « ${v.name} » ?`, message: 'Ses statistiques ne seront plus affichées.', confirmLabel: 'Supprimer' });
                              if (ok) run('del', async () => void (await growthApi.deleteVariant(v.id)), 'Variante supprimée');
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {hasVariants && (
        <p className="mt-2 text-xs text-slate-500">
          Trafic : poids relatifs (50 / 50 = moitié-moitié). Une conclusion n’est affichée qu’avec au moins 100 visiteurs par version ; même alors, laissez tourner le test au moins une semaine complète.
        </p>
      )}
    </Card>
  );
}

function WeightInput({ value, onSave }: { value: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  const commit = () => {
    const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    setV(String(n));
    if (n !== value) onSave(n);
  };
  return (
    <Input
      type="number"
      min={0}
      max={100}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
      className="h-8 w-16 text-right"
      aria-label="Poids du trafic"
    />
  );
}

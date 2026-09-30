/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import type { ReactNode } from 'react';
import { Building2, type LucideIcon } from 'lucide-react';
import { Badge, Button, Card } from '../../../web/src/components/ui';
import { useEdition } from '../../../web/src/lib/edition';
import { FEATURE_LABELS, type EnterpriseFeature } from '../../shared/types';

/** Sober screen shown instead of an Enterprise feature when the instance has no (valid) license for it. */
export function EnterpriseFeatureScreen({ feature, icon: Icon = Building2, children }: { feature: EnterpriseFeature; icon?: LucideIcon; children: ReactNode }) {
  const { info } = useEdition();
  const status = info?.license.status ?? 'none';
  const reason =
    status === 'expired'
      ? 'Votre licence a expiré.'
      : status === 'invalid'
        ? 'La clé de licence de cette instance n’est pas valide.'
        : status === 'none'
          ? 'Aucune licence n’est installée sur cette instance.'
          : 'Votre licence ne comprend pas cette fonction.';
  return (
    <Card className="px-6 py-10 text-center">
      <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
        <Icon size={22} strokeWidth={1.75} />
      </span>
      <Badge tone="slate" className="mb-3">
        Fonction de l’édition Entreprise
      </Badge>
      <h3 className="font-display text-lg font-extrabold tracking-[-0.02em] text-ink">{FEATURE_LABELS[feature]}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{children}</p>
      <p className="mx-auto mt-3 max-w-md text-xs text-slate-400">
        {reason} Tout le reste de Scalo — tunnels, emails, contacts, automatisations — reste disponible sans limite.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-5"
        onClick={() => {
          window.location.hash = 'licence';
          window.location.reload();
        }}
      >
        Voir la licence
      </Button>
    </Card>
  );
}

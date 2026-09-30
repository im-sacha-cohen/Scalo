/**
 * Scalo Enterprise Edition — Copyright (c) 2026 Scalo. All rights reserved.
 * Licensed under the Scalo Enterprise License (see ee/LICENSE): source-available, NOT open source.
 * Production use requires a valid Scalo Enterprise subscription and license key.
 */
import { Link } from 'react-router';
import { Eye, Info } from 'lucide-react';
import { useEdition } from '../../../web/src/lib/edition';
import { fmtDate } from '../../../web/src/lib/format';

const DAY = 86_400_000;

/** Discreet, non-blocking notices above the page: license about to expire / expired (administrators), read-only role. */
export function Banner() {
  const { info, role, isAdmin } = useEdition();
  if (!info) return null;
  const { status, expires_at, grace_until } = info.license;
  const daysLeft = expires_at ? Math.ceil((Date.parse(expires_at) - Date.now()) / DAY) : null;

  let license: string | null = null;
  if (isAdmin) {
    if (status === 'grace') license = `Votre licence Entreprise a expiré le ${fmtDate(expires_at)}. Les fonctions Entreprise restent actives jusqu’au ${fmtDate(grace_until)}.`;
    else if (status === 'expired') license = 'Votre licence Entreprise a expiré : les fonctions Entreprise sont désactivées. Vos données et le reste de l’application ne sont pas touchés.';
    else if (status === 'valid' && daysLeft !== null && daysLeft <= 14) license = `Votre licence Entreprise expire ${daysLeft <= 1 ? 'demain' : `dans ${daysLeft} jours`}.`;
  }

  if (!license && role !== 'viewer') return null;
  return (
    <div className="mb-5 space-y-2">
      {license && (
        <div className="flex items-start gap-2.5 rounded-lg bg-amber-50 px-3.5 py-2 text-sm text-amber-900">
          <Info size={16} className="mt-0.5 shrink-0 text-amber-600" />
          <p>
            {license}{' '}
            <Link to="/settings#licence" reloadDocument className="font-medium underline underline-offset-2">
              Gérer la licence
            </Link>
          </p>
        </div>
      )}
      {role === 'viewer' && (
        <div className="flex items-center gap-2.5 rounded-lg bg-slate-100 px-3.5 py-2 text-sm text-slate-600">
          <Eye size={16} className="shrink-0 text-slate-400" />
          Accès en lecture seule sur le compte {info.account.name} : vous pouvez tout consulter, sans modifier.
        </div>
      )}
    </div>
  );
}
